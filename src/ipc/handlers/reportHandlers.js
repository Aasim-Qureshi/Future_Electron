const pythonAPI = require('../../services/python/PythonAPI');

const reportHandlers = {
    async handleValidateReport(event, reportId) {
        try {
            console.log('[MAIN] Received validate report request:', reportId);

            const result = await pythonAPI.report.validateReport(reportId);
            console.log("Result at handler:", result);

            if (result.status === 'SUCCESS') {
                return { status: 'SUCCESS', message: 'Report is valid' };
            } else if (result.status === 'NOT_FOUND') {
                return { status: 'NOT_FOUND', message: 'Report not found' };
            } else if (result.status === 'MACROS_EXIST') {
                return { status: 'MACROS_EXIST', message: 'Report has macros' };
            } else {
                return { status: 'ERROR', error: result.error || 'Report validation failed' };
            }
        } catch (error) {
            console.error('[MAIN] Validate report error:', error);
            return { status: 'ERROR', error: error.message };
        }
    }
};

module.exports = reportHandlers;