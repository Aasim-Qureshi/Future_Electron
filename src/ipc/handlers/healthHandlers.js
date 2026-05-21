// handlers/healthHandlers.js
const httpClient = require('../../api/httpClient');

const healthHandlers = {
    async handleHealth(event) {
        try {
            // call /health on the configured ValueTech backend
            const res = await httpClient.get('/health');

            // Return a normalized payload to the renderer
            return {
                ok: true,
                status: res.status,
                data: res.data
            };
        } catch (err) {
            console.error('[MAIN] health check error:', err && err.message ? err.message : err);
            return {
                ok: false,
                error: err.message || 'Unknown error',
                status: err.response?.status,
                data: err.response?.data
            };
        }
    }
};

module.exports = healthHandlers;
