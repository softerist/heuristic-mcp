/**
 * Call Graph Extractor
 *
 * Lightweight regex-based extraction of function definitions and calls.
 * Works across multiple languages without external dependencies.
 */

import path from 'path';

// Language-specific patterns for function/method definitions
const DEFINITION_PATTERNS = {
  javascript: [
    // function declarations: function name() or async function name()
    /(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    // arrow functions: const name = () => or const name = async () =>
    /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    // class declarations
    /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    // method definitions: name() { or async name() {
    /^\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/gm,
    // object method shorthand: name() { inside object
    /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/g,
  ],
  python: [
    // def name():
    /def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
    // class Name:
    /class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/g,
  ],
  go: [
    // func name() or func (r Receiver) name()
    /func\s+(?:\([^)]*\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
  ],
  rust: [
    // fn name()
    /fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/g,
    // impl Name
    /impl(?:\s*<[^>]*>)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  ],
  java: [
    // public void name() or private static String name()
    /(?:public|private|protected)?\s*(?:static)?\s*(?:\w+)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
    // class Name
    /class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  ],
};

// Pattern for function calls (language-agnostic, catches most cases)
const CALL_PATTERN = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

// Common built-ins to exclude from call detection (all lowercase for case-insensitive matching)
const BUILTIN_EXCLUSIONS = new Set([
  // JavaScript
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
  // Common functions that aren't meaningful for call graphs
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
  // Python
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
  // Go
  'func',
  'make',
  'append',
  'cap',
  'panic',
  'recover',
  // Control flow that looks like function calls
  'else',
  'try',
  'finally',
  'with',
  'assert',
  'raise',
  'yield',
  // Test frameworks
  'describe',
  'it',
  'test',
  'expect',
  'beforeeach',
  'aftereach',
  'beforeall',
  'afterall',
  // Common prototypes / methods (too noisy)
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

/**
 * Detect language from file extension
 */
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
    return 'javascript'; // Default to JS patterns
  }
}

/**
 * Extract function/class definitions from content
 */
export function extractDefinitions(content, file) {
  const language = detectLanguage(file);
  const patterns = DEFINITION_PATTERNS[language];
  const definitions = new Set();

  for (const pattern of patterns) {
    // Reset regex state
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

/**
 * Extract function calls from content
 */
export function extractCalls(content, file) {
  const calls = new Set();

  // Remove string literals and comments to avoid false positives
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

/**
 * Remove string literals and comments to improve extraction accuracy
 */
function removeStringsAndComments(content, file) {
  const ext = path.extname(file).toLowerCase();

  // Remove single-line comments
  let cleaned = content.replace(/\/\/.*$/gm, '');

  // Remove multi-line comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove Python comments
  if (ext === '.py' || ext === '.pyw') {
    cleaned = cleaned.replace(/#.*$/gm, '');
    // Remove triple-quoted strings (docstrings)
    cleaned = cleaned.replace(/"""[\s\S]*?"""/g, '');
    cleaned = cleaned.replace(/'''[\s\S]*?'''/g, '');
  }

  // Remove string literals (simplified - handles most cases)
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, '``');

  return cleaned;
}

/**
 * Extract both definitions and calls from a file
 */
export function extractCallData(content, file) {
  const definitions = extractDefinitions(content, file);
  const calls = extractCalls(content, file);

  // Remove self-references (calls to functions defined in same file)
  const definitionSet = new Set(definitions);
  const externalCalls = calls.filter((c) => !definitionSet.has(c));

  return {
    definitions,
    calls: externalCalls,
  };
}

/**
 * Build a call graph from file data
 */
export function buildCallGraph(fileCallData) {
  const defines = new Map(); // symbol -> files that define it
  const calledBy = new Map(); // symbol -> files that call it
  const fileCalls = new Map(); // file -> symbols it calls

  for (const [file, data] of fileCallData.entries()) {
    // Record definitions
    for (const def of data.definitions) {
      if (!defines.has(def)) {
        defines.set(def, []);
      }
      defines.get(def).push(file);
    }

    // Record calls
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

/**
 * Get files related to a set of symbols (callers + callees)
 */
export function getRelatedFiles(callGraph, symbols, maxHops = 1) {
  const related = new Map(); // file -> proximity score (1 = direct, 0.5 = indirect)
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

// Patterns for extracting symbols from content
const SYMBOL_PATTERNS = [
  // function name()
  /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  // class Name
  /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  // const/let/var name = ...
  /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
  // Python def/class
  /def\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  /class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  // Go func
  /func\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  // Rust fn
  /fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
  // Java/C# methods (simplified)
  /(?:public|private|protected|static)\s+\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
];

/**
 * Extract symbols (function/class names) from search results
 */
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
