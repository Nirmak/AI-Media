/**
 * Real-time logger for the AI-Media Literary Analysis System
 * Provides immediate console output and logging storage
 */

// Set up logging configuration
const MAX_LOGS = 100;
const recentLogs = [];

// Custom logger that stores logs in memory and ensures they're flushed immediately
const logger = {
  log: function(type, message) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      type,
      timestamp,
      message: typeof message === 'string' ? message : JSON.stringify(message)
    };
    
    // Store in our recent logs buffer
    recentLogs.push(logEntry);
    if (recentLogs.length > MAX_LOGS) {
      recentLogs.shift();
    }
    
    // Always print to console immediately
    // Using process.stdout.write ensures we flush immediately
    process.stdout.write(`[${timestamp}] [${type}] ${logEntry.message}\n`);
  },
  llm: function(source, response) {
    this.log('LLM', `===== LLM RESPONSE (${source}) =====\n${response}\n================================`);
  },
  info: function(message) {
    this.log('INFO', message);
  },
  error: function(message) {
    this.log('ERROR', message);
  },
  getRecentLogs: function() {
    return recentLogs;
  }
};

// Export the logger
module.exports = logger; 