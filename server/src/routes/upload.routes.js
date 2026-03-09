/**
 * Upload API — handles file uploads from the client
 */
import { Router } from 'express';
import multer from 'multer';
import { mkdir } from 'fs/promises';
import { join, extname } from 'path';

const router = Router();

const uploadDir = process.env.UPLOAD_DIR || './uploads';

// Configure multer
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const dir = join(uploadDir, 'user-uploads');
        await mkdir(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = extname(file.originalname);
        const name = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
        cb(null, name);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'audio/mpeg', 'application/pdf'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} not supported`));
        }
    },
});

// POST /api/upload — upload a single file
router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    res.json({
        fileName: req.file.originalname,
        storedName: req.file.filename,
        filePath: req.file.path,
        fileUrl: `/uploads/user-uploads/${req.file.filename}`,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
    });
});

// POST /api/upload/batch — upload multiple files (up to 20)
router.post('/batch', upload.array('files', 20), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files.map(f => ({
        fileName: f.originalname,
        storedName: f.filename,
        filePath: f.path,
        fileUrl: `/uploads/user-uploads/${f.filename}`,
        fileSize: f.size,
        mimeType: f.mimetype,
    }));

    res.json({ files });
});

export default router;

