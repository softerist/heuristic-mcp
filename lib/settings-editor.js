function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function detectIndentUnit(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(\s+)"/);
    if (match) return match[1];
  }
  return '  ';
}

function getLineIndent(text, index) {
  const lineStart = Math.max(text.lastIndexOf('\n', index - 1), text.lastIndexOf('\r', index - 1));
  const start = lineStart === -1 ? 0 : lineStart + 1;
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return text.slice(start, i);
}

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escape = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }

  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

export function parseJsonc(text) {
  const cleaned = stripTrailingCommas(stripJsonComments(text));
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function skipWhitespaceAndComments(text, start, end) {
  let i = start;
  while (i < end) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < end && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < end - 1 && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function readString(text, start, end) {
  let i = start + 1;
  let value = '';
  let escape = false;
  while (i < end) {
    const ch = text[i];
    if (escape) {
      value += ch;
      escape = false;
    } else if (ch === '\\') {
      value += ch;
      escape = true;
    } else if (ch === '"') {
      return { value, end: i + 1 };
    } else {
      value += ch;
    }
    i += 1;
  }
  return { value, end: i };
}

function scanComposite(text, start, end, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let inLine = false;
  let inBlock = false;

  for (let i = start; i < end; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === openChar) {
      depth += 1;
      continue;
    }
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return end;
}

function scanValue(text, start, end) {
  let i = skipWhitespaceAndComments(text, start, end);
  const valueStart = i;
  if (i >= end) {
    return { valueStart: end, valueEnd: end, valueEndWithComma: end };
  }

  const ch = text[i];
  let valueEnd = i;

  if (ch === '{') {
    valueEnd = scanComposite(text, i, end, '{', '}');
  } else if (ch === '[') {
    valueEnd = scanComposite(text, i, end, '[', ']');
  } else if (ch === '"') {
    const result = readString(text, i, end);
    valueEnd = result.end;
  } else {
    let inString = false;
    let escape = false;
    let inLine = false;
    let inBlock = false;
    for (; i < end; i += 1) {
      const c = text[i];
      const next = text[i + 1];
      if (inLine) {
        if (c === '\n') inLine = false;
        continue;
      }
      if (inBlock) {
        if (c === '*' && next === '/') {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '/' && next === '/') {
        inLine = true;
        i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        inBlock = true;
        i += 1;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === ',' || c === '}' || c === ']') {
        break;
      }
    }
    valueEnd = i;
  }

  let valueEndWithComma = valueEnd;
  let j = skipWhitespaceAndComments(text, valueEnd, end);
  if (text[j] === ',') {
    valueEndWithComma = j + 1;
  }

  return { valueStart, valueEnd, valueEndWithComma };
}

function findRootObjectRange(text) {
  let inString = false;
  let escape = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      const end = scanComposite(text, i, text.length, '{', '}');
      if (end > i) return { start: i, end };
    }
  }

  return null;
}

function findPropertyValueRange(text, objRange, key) {
  let i = objRange.start + 1;
  const end = objRange.end - 1;
  let expectKey = true;

  while (i < end) {
    i = skipWhitespaceAndComments(text, i, end);
    if (i >= end) break;
    const ch = text[i];
    if (ch === '}') break;
    if (ch === ',') {
      expectKey = true;
      i += 1;
      continue;
    }
    if (!expectKey) {
      const valueInfo = scanValue(text, i, end);
      i = valueInfo.valueEndWithComma;
      expectKey = true;
      continue;
    }
    if (ch !== '"') {
      i += 1;
      continue;
    }
    const keyResult = readString(text, i, end);
    const keyName = keyResult.value;
    const keyStart = i;
    const keyEnd = keyResult.end;
    let afterKey = skipWhitespaceAndComments(text, keyEnd, end);
    if (text[afterKey] !== ':') {
      i = keyEnd;
      continue;
    }
    const valueInfo = scanValue(text, afterKey + 1, end);
    if (keyName === key) {
      return {
        keyStart,
        keyEnd,
        valueStart: valueInfo.valueStart,
        valueEnd: valueInfo.valueEnd,
        valueEndWithComma: valueInfo.valueEndWithComma,
      };
    }
    i = valueInfo.valueEndWithComma;
    expectKey = true;
  }

  return null;
}

function formatJsonValue(value, indentUnit, parentIndent, newline) {
  const raw = JSON.stringify(value, null, indentUnit);
  if (!raw.includes('\n')) return raw;
  return raw.replace(/\n/g, `${newline}${parentIndent}`);
}

function findObjectRangeFromValue(text, valueStart, valueEnd) {
  const start = skipWhitespaceAndComments(text, valueStart, valueEnd);
  if (text[start] !== '{') return null;
  const end = scanComposite(text, start, valueEnd, '{', '}');
  return { start, end };
}

function insertPropertyIntoObject(text, objRange, key, valueText, indentUnit, newline) {
  const objectIndent = getLineIndent(text, objRange.start);
  const propertyIndent = `${objectIndent}${indentUnit}`;
  const entry = `${propertyIndent}"${key}": ${valueText}`;

  const before = text.slice(0, objRange.start + 1);
  const inside = text.slice(objRange.start + 1, objRange.end - 1);
  const after = text.slice(objRange.end - 1);

  const contentIndex = skipWhitespaceAndComments(text, objRange.start + 1, objRange.end - 1);
  const hasEntries = contentIndex < objRange.end - 1;
  if (!hasEntries) {
    return `${before}${newline}${entry}${newline}${objectIndent}}${after.slice(1)}`;
  }

  const insideEndIndex = objRange.start + 1 + inside.length;
  let insertPoint = insideEndIndex;
  let j = objRange.end - 2;
  while (j > objRange.start && /\s/.test(text[j])) j -= 1;
  const needsComma = text[j] !== ',';
  const comma = needsComma ? ',' : '';

  return (
    text.slice(0, insertPoint) +
    comma +
    newline +
    entry +
    newline +
    objectIndent +
    text.slice(objRange.end - 1)
  );
}

function replaceRange(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

function resolveContainer(text, rootRange) {
  const containers = [
    { type: 'key', key: 'mcpServers' },
    { type: 'key', key: 'cline.mcpServers' },
    { type: 'nested', key: 'cline', child: 'mcpServers' },
  ];

  for (const candidate of containers) {
    if (candidate.type === 'key') {
      const entry = findPropertyValueRange(text, rootRange, candidate.key);
      if (entry) {
        return { entry, containerKey: candidate.key };
      }
      continue;
    }
    if (candidate.type === 'nested') {
      const parent = findPropertyValueRange(text, rootRange, candidate.key);
      if (!parent) continue;
      const parentObj = findObjectRangeFromValue(text, parent.valueStart, parent.valueEnd);
      if (!parentObj) {
        return {
          entry: parent,
          containerKey: candidate.key,
          needsObjectReplace: true,
          childKey: candidate.child,
        };
      }
      const child = findPropertyValueRange(text, parentObj, candidate.child);
      if (child) {
        return {
          entry: child,
          containerKey: candidate.child,
          parentRange: parentObj,
          parentEntry: parent,
        };
      }
      return {
        entry: null,
        containerKey: candidate.child,
        parentRange: parentObj,
        parentEntry: parent,
      };
    }
  }

  return null;
}

export function upsertMcpServerEntryInText(text, serverName, serverConfig) {
  const newline = detectNewline(text);
  const indentUnit = detectIndentUnit(text);
  const trimmed = text.trim();

  if (!trimmed) {
    const payload = {
      mcpServers: {
        [serverName]: serverConfig,
      },
    };
    return JSON.stringify(payload, null, indentUnit) + newline;
  }

  const rootRange = findRootObjectRange(text);
  if (!rootRange) {
    return null;
  }

  const container = resolveContainer(text, rootRange);

  if (!container) {
    const objectIndent = getLineIndent(text, rootRange.start);
    const propertyIndent = `${objectIndent}${indentUnit}`;
    const valueText = formatJsonValue(
      { [serverName]: serverConfig },
      indentUnit,
      propertyIndent,
      newline
    );
    return insertPropertyIntoObject(text, rootRange, 'mcpServers', valueText, indentUnit, newline);
  }

  if (container.needsObjectReplace) {
    const replacementValue = container.childKey
      ? { [container.childKey]: { [serverName]: serverConfig } }
      : { [serverName]: serverConfig };
    const parentIndent = getLineIndent(text, container.entry.keyStart);
    const valueText = formatJsonValue(replacementValue, indentUnit, parentIndent, newline);
    return replaceRange(text, container.entry.valueStart, container.entry.valueEnd, valueText);
  }

  if (container.parentRange && !container.entry) {
    const propertyIndent = `${getLineIndent(text, container.parentRange.start)}${indentUnit}`;
    const valueText = formatJsonValue(
      { [serverName]: serverConfig },
      indentUnit,
      propertyIndent,
      newline
    );
    return insertPropertyIntoObject(
      text,
      container.parentRange,
      container.containerKey,
      valueText,
      indentUnit,
      newline
    );
  }

  if (!container.entry) {
    return null;
  }

  const containerObject = findObjectRangeFromValue(
    text,
    container.entry.valueStart,
    container.entry.valueEnd
  );
  if (!containerObject) {
    const parentIndent = getLineIndent(text, container.entry.keyStart);
    const valueText = formatJsonValue(
      { [serverName]: serverConfig },
      indentUnit,
      parentIndent,
      newline
    );
    return replaceRange(text, container.entry.valueStart, container.entry.valueEnd, valueText);
  }

  const existingEntry = findPropertyValueRange(text, containerObject, serverName);
  if (existingEntry) {
    const entryIndent = getLineIndent(text, existingEntry.keyStart);
    const valueText = formatJsonValue(serverConfig, indentUnit, entryIndent, newline);
    return replaceRange(text, existingEntry.valueStart, existingEntry.valueEnd, valueText);
  }

  const objectIndent = getLineIndent(text, containerObject.start);
  const propertyIndent = `${objectIndent}${indentUnit}`;
  const valueText = formatJsonValue(serverConfig, indentUnit, propertyIndent, newline);
  return insertPropertyIntoObject(
    text,
    containerObject,
    serverName,
    valueText,
    indentUnit,
    newline
  );
}

export function findMcpServerEntry(config, serverName) {
  if (!config || typeof config !== 'object') return null;
  if (config.mcpServers && config.mcpServers[serverName]) {
    return { containerKey: 'mcpServers', entry: config.mcpServers[serverName] };
  }
  if (config['cline.mcpServers'] && config['cline.mcpServers'][serverName]) {
    return {
      containerKey: 'cline.mcpServers',
      entry: config['cline.mcpServers'][serverName],
    };
  }
  if (config.cline && config.cline.mcpServers && config.cline.mcpServers[serverName]) {
    return {
      containerKey: 'cline.mcpServers',
      entry: config.cline.mcpServers[serverName],
    };
  }
  return null;
}
