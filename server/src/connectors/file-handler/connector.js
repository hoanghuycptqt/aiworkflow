/**
 * File Handler Connectors — Upload and Download files
 */

import { BaseConnector } from '../base-connector.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';

export class FileUploadConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'File Upload',
            description: 'Upload and provide files as input to the workflow',
            icon: '📤',
            category: 'utility',
            configSchema: {
                filePath: {
                    type: 'text',
                    label: 'File Path / URL',
                    description: 'Path to the file to upload or URL. Also accepts data from execution input.',
                },
            },
        };
    }

    async execute(input, credentials, config) {
        // Support: 1) config.filePaths (UI uploads), 2) input.filePaths (from job input), 3) legacy config.filePath
        let paths = config.filePaths || [];
        if (!paths.length && input.filePaths && input.filePaths.length) {
            // Job input images — injected from job definition
            paths = input.filePaths;
        }
        if (!paths.length && config.filePath) {
            paths = [config.filePath];
        }
        if (!paths.length && (input.filePath || input.imageUrl)) {
            paths = [input.filePath || input.imageUrl];
        }

        if (!paths.length) {
            throw new Error('No files provided. Upload images or enter URLs.');
        }

        const uploadsDir = process.env.UPLOAD_DIR || './uploads';
        const images = [];

        for (const filePath of paths) {
            try {
                const imgData = await this._loadImage(filePath, uploadsDir);
                images.push(imgData);
            } catch (e) {
                console.warn(`[FileUpload] Skipping ${filePath}: ${e.message}`);
            }
        }

        if (!images.length) {
            throw new Error('No images could be loaded.');
        }

        // Backward compat: first image's fields at top level
        const first = images[0];
        return {
            ...first,
            images,
            imageCount: images.length,
        };
    }

    async _loadImage(filePath, uploadsDir) {
        // Handle /uploads/ URLs from our upload API
        if (filePath.startsWith('/uploads/')) {
            const localPath = join(uploadsDir, filePath.replace('/uploads/', ''));
            const buffer = await readFile(localPath);
            return {
                filePath: localPath,
                imageUrl: filePath,
                fileName: basename(localPath),
                fileSize: buffer.length,
                imageData: buffer.toString('base64'),
                imageMimeType: filePath.match(/\.(png)$/i) ? 'image/png' : filePath.match(/\.(webp)$/i) ? 'image/webp' : 'image/jpeg',
            };
        }

        // If it's a URL, download it
        if (filePath.startsWith('http')) {
            const response = await fetch(filePath);
            if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

            const buffer = Buffer.from(await response.arrayBuffer());
            await mkdir(uploadsDir, { recursive: true });

            const filename = `input_${Date.now()}_${basename(filePath).split('?')[0] || 'file'}`;
            const savePath = join(uploadsDir, filename);
            await writeFile(savePath, buffer);

            return {
                filePath: savePath,
                imageUrl: `/uploads/${filename}`,
                fileName: filename,
                fileSize: buffer.length,
                imageData: buffer.toString('base64'),
                imageMimeType: 'image/jpeg',
            };
        }

        // Local file
        const buffer = await readFile(filePath);
        return {
            filePath,
            imageUrl: filePath.replace(uploadsDir, '/uploads'),
            fileName: basename(filePath),
            fileSize: buffer.length,
            imageData: buffer.toString('base64'),
            imageMimeType: filePath.match(/\.(png)$/i) ? 'image/png' : filePath.match(/\.(webp)$/i) ? 'image/webp' : 'image/jpeg',
        };
    }
}

export class FileDownloadConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'File Download',
            description: 'Download and save output files from the workflow',
            icon: '📥',
            category: 'utility',
            configSchema: {
                outputDir: {
                    type: 'text',
                    label: 'Output Directory',
                    description: 'Directory to save files (relative to uploads)',
                    default: 'output',
                },
                fileName: {
                    type: 'text',
                    label: 'Custom File Name',
                    description: 'Custom name for the output file (optional)',
                },
            },
        };
    }

    async execute(input, credentials, config) {
        const sourceUrl = input.videoUrl || input.imageUrl || input.fileUrl;
        const sourcePath = input.videoPath || input.imagePath || input.filePath;

        if (!sourceUrl && !sourcePath) {
            throw new Error('No file to download from previous node');
        }

        const uploadsDir = process.env.UPLOAD_DIR || './uploads';
        const outputDir = join(uploadsDir, config.outputDir || 'output');
        await mkdir(outputDir, { recursive: true });

        let fileName = config.fileName;
        if (!fileName) {
            const source = sourcePath || sourceUrl;
            const ext = source.split('.').pop()?.split('?')[0] || 'bin';
            fileName = `output_${Date.now()}.${ext}`;
        }

        const outputPath = join(outputDir, fileName);

        if (sourcePath) {
            // Copy local file
            const data = await readFile(sourcePath);
            await writeFile(outputPath, data);
        } else if (sourceUrl.startsWith('http')) {
            // Download from URL
            const response = await fetch(sourceUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await writeFile(outputPath, buffer);
        } else {
            // Relative URL — copy from uploads
            const fullSource = join(uploadsDir, sourceUrl.replace('/uploads', ''));
            const data = await readFile(fullSource);
            await writeFile(outputPath, data);
        }

        return {
            filePath: outputPath,
            fileUrl: `/uploads/${config.outputDir || 'output'}/${fileName}`,
            fileName,
            status: 'downloaded',
        };
    }
}
