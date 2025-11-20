const workerHandlers = require('./workerHandlers');

const authHandlers = require('./authHandlers');
const reportHandlers = require('./reportHandlers');

module.exports = {
    authHandlers,
    workerHandlers,
    reportHandlers
};