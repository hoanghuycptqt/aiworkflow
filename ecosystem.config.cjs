module.exports = {
    apps: [{
        name: 'vcw-server',
        cwd: '/opt/vcw/app/server',
        script: 'src/index.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'production',
            PORT: 3001,
        },
        // Log config
        error_file: '/opt/vcw/logs/server-error.log',
        out_file: '/opt/vcw/logs/server-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        merge_logs: true,
    }],
};
