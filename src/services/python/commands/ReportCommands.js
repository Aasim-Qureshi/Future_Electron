class ReportCommands {
    constructor(workerService) {
        if (!workerService) {
            throw new Error('WorkerService is required');
        }
        this.worker = workerService;
    }

    async _sendCommand(command) {
        return await this.worker.sendCommand(command);
    }

    async validateReport(reportId) {
        return this._sendCommand({
            action: 'validate-report',
            reportId
        });
    }
}

module.exports = ReportCommands;