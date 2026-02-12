let correlationCounter = 0;

function generateCorrelationId() {
  correlationCounter += 1;
  return `tc-${Date.now()}-${correlationCounter}`;
}

function formatEntry(severity, context, message, data, correlationId) {
  return {
    timestamp: new Date().toISOString(),
    severity,
    context,
    correlationId: correlationId || null,
    message,
    data: data || null,
  };
}

function log(severity, context, message, data, correlationId) {
  const entry = formatEntry(severity, context, message, data, correlationId);
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

export function createLogger(context) {
  return {
    debug(message, data, correlationId) {
      return log('debug', context, message, data, correlationId);
    },
    info(message, data, correlationId) {
      return log('info', context, message, data, correlationId);
    },
    warn(message, data, correlationId) {
      return log('warn', context, message, data, correlationId);
    },
    error(message, data, correlationId) {
      return log('error', context, message, data, correlationId);
    },
    correlationId() {
      return generateCorrelationId();
    },
  };
}
