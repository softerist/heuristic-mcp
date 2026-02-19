

import path from 'path';


const DEFINITION_PATTERNS = {
  javascript: [
    
    /(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    
    /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    
    /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    
    /^\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/gm,
    
    /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/g,
  ],
  python: [
    
    /def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
    
    /class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/g,
  ],
  go: [
    
    /func\s+(?:\([^)]*\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
  ],
  rust: [
    
    /fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/g,
    
    /impl(?:\s*<[^>]*>)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  ],
  java: [
    
    /(?:public|private|protected)?\s*(?:static)?\s*(?:\w+)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
    
    /class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  ],
};


const CALL_PATTERN = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;


const BUILTIN_EXCLUSIONS = new Set([
  
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'async',
  'await',
  'return',
  'throw',
  'new',
  'typeof',
  'instanceof',
  'delete',
  'void',
  'console',
  'require',
  'import',
  'export',
  'super',
  'this',
  
  'parseint',
  'parsefloat',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'map',
  'set',
  'promise',
  'error',
  'json',
  'math',
  'date',
  'regexp',
  
  'def',
  'class',
  'print',
  'len',
  'range',
  'str',
  'int',
  'float',
  'list',
  'dict',
  'tuple',
  'bool',
  'type',
  'isinstance',
  'hasattr',
  'getattr',
  'setattr',
  
  'func',
  'make',
  'append',
  'cap',
  'panic',
  'recover',
  
  'else',
  'try',
  'finally',
  'with',
  'assert',
  'raise',
  'yield',
  
  'describe',
  'it',
  'test',
  'expect',
  'beforeeach',
  'aftereach',
  'beforeall',
  'afterall',
  
  'match',
  'exec',
  'replace',
  'split',
  'join',
  'slice',
  'splice',
  'push',
  'pop',
  'shift',
  'unshift',
  'includes',
  'indexof',
  'foreach',
  'filter',
  'reduce',
  'find',
  'some',
  'every',
  'sort',
  'keys',
  'values',
  'entries',
  'from',
  'then',
  'catch',
  'finally',
  'all',
  'race',
  'resolve',
  'reject',
]);


function detectLanguage(file) {
  const ext = path.extname(file).toLowerCase();
  const langMap = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'javascript',
    '.tsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.pyw': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'java',
    '.scala': 'java',
  };
  if (langMap[ext]) {
    return langMap[ext];
  } else {
    return 'javascript'; 
  }
}


export function extractDefinitions(content, file) {
  const language = detectLanguage(file);
  const patterns = DEFINITION_PATTERNS[language];
  const definitions = new Set();

  for (const pattern of patterns) {
    
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name && name.length > 1 && !BUILTIN_EXCLUSIONS.has(name.toLowerCase())) {
        definitions.add(name);
      }
    }
  }

  return Array.from(definitions);
}


export function extractCalls(content, file) {
  const calls = new Set();

  
  const cleanContent = removeStringsAndComments(content, file);

  CALL_PATTERN.lastIndex = 0;
  let match;
  while ((match = CALL_PATTERN.exec(cleanContent)) !== null) {
    const name = match[1];
    if (name && name.length > 1 && !BUILTIN_EXCLUSIONS.has(name.toLowerCase())) {
      calls.add(name);
    }
  }

  return Array.from(calls);
}


function removeStringsAndComments(content, file) {
  const ext = path.extname(file).toLowerCase();

  
  let cleaned = content.replace(/\/\/.*$/gm, '');

  
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  
  if (ext === '.py' || ext === '.pyw') {
    cleaned = cleaned.replace(/#.*$/gm, '');
    
    cleaned = cleaned.replace(/"""[\s\S]*?"""/g, '');
    cleaned = cleaned.replace(/'''[\s\S]*?'''/g, '');
  }

  
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, '``');

  return cleaned;
}


export function extractCallData(content, file) {
  const definitions = extractDefinitions(content, file);
  const calls = extractCalls(content, file);

  
  const definitionSet = new Set(definitions);
  const externalCalls = calls.filter((c) => !definitionSet.has(c));

  return {
    definitions,
    calls: externalCalls,
  };
}


export function buildCallGraph(fileCallData) {
  const defines = new Map(); 
  const calledBy = new Map(); 
  const fileCalls = new Map(); 

  for (const [file, data] of fileCallData.entries()) {
    
    for (const def of data.definitions) {
      if (!defines.has(def)) {
        defines.set(def, []);
      }
      defines.get(def).push(file);
    }

    
    fileCalls.set(file, data.calls);
    for (const call of data.calls) {
      if (!calledBy.has(call)) {
        calledBy.set(call, []);
      }
      calledBy.get(call).push(file);
    }
  }

  return { defines, calledBy, fileCalls };
}


export function getRelatedFiles(callGraph, symbols, maxHops = 1) {
  const related = new Map(); 
  const visited = new Set();

  function explore(currentSymbols, hop) {
    if (hop > maxHops) return;
    const score = 1 / (hop + 1); // Decay with distance

    for (const symbol of currentSymbols) {
      // Files that define this symbol
      const definers = callGraph.defines.get(symbol) || [];
      for (const file of definers) {
        if (!visited.has(file)) {
          related.set(file, Math.max(related.get(file) || 0, score));
        }
      }

      // Files that call this symbol
      const callers = callGraph.calledBy.get(symbol) || [];
      for (const file of callers) {
        if (!visited.has(file)) {
          related.set(file, Math.max(related.get(file) || 0, score));
        }
      }

      // For next hop, find what these files call/define
      if (hop < maxHops) {
        const nextSymbols = new Set();
        for (const file of [...definers, ...callers]) {
          visited.add(file);
          const calls = callGraph.fileCalls.get(file) || [];
          for (const c of calls) nextSymbols.add(c);
        }
        explore(nextSymbols, hop + 1);
      }
    }
  }

  explore(symbols, 0);
  return related;
}


const SYMBOL_PATTERNS = [
  
  /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  
  /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  
  /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
  
  /def\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  /class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  
  /func\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  
  /fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  
  /(?:public|private|protected|static)\s+\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
];


export function extractSymbolsFromContent(content) {
  const symbols = new Set();

  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && match[1].length > 2) {
        symbols.add(match[1]);
      }
    }
  }

  return Array.from(symbols);
}
