/**
 * Structured JSON logger for the TabCycle extension.
 *
 * Every log entry includes a timestamp, severity level, originating context,
 * an optional correlation ID (for tracing related operations across async
 * boundaries), and optional data payload.
 */

let nextCorrelationSequenceNumber = 0;

/**
 * Generates a unique correlation ID for tracing related log entries.
 * Format: "tc-{timestamp}-{sequence}" (e.g. "tc-1708876543210-7").
 */
function generateUniqueCorrelationId() {
  nextCorrelationSequenceNumber += 1;
  return `tc-${Date.now()}-${nextCorrelationSequenceNumber}`;
}

/**
 * Builds a structured log entry object with all standard fields.
 * @param {string} severity - One of: 'debug', 'info', 'warn', 'error'
 * @param {string} originContext - The module or area that produced this log
 * @param {string} message - Human-readable description of the event
 * @param {object|null} data - Optional structured data payload
 * @param {string|null} correlationId - Optional ID for tracing related entries
 */
function buildStructuredLogEntry(severity, originContext, message, data, correlationId) {
  return {
    timestamp: new Date().toISOString(),
    severity,
    context: originContext,
    correlationId: correlationId || null,
    message,
    data: data || null,
  };
}

/**
 * Writes a structured log entry to the console at the appropriate severity level.
 */
function writeLogEntryToConsole(severity, originContext, message, data, correlationId) {
  const entry = buildStructuredLogEntry(severity, originContext, message, data, correlationId);
  switch (severity) {
    case 'error':
      console.error(JSON.stringify(entry));
      break;
    case 'warn':
      console.warn(JSON.stringify(entry));
      break;
    case 'debug':
      console.debug(JSON.stringify(entry));
      break;
    default:
      console.log(JSON.stringify(entry));
  }
  return entry;
}

/**
 * Creates a logger bound to a specific context (e.g. 'background', 'options').
 * The returned object provides debug/info/warn/error methods plus a
 * correlationId() factory for creating trace IDs.
 *
 * @param {string} originContext - The module name or area this logger represents
 */
export function createLogger(originContext) {
  return {
    debug(message, data, correlationId) {
      return writeLogEntryToConsole('debug', originContext, message, data, correlationId);
    },
    info(message, data, correlationId) {
      return writeLogEntryToConsole('info', originContext, message, data, correlationId);
    },
    warn(message, data, correlationId) {
      return writeLogEntryToConsole('warn', originContext, message, data, correlationId);
    },
    error(message, data, correlationId) {
      return writeLogEntryToConsole('error', originContext, message, data, correlationId);
    },
    correlationId() {
      return generateUniqueCorrelationId();
    },
  };
}
