import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAGIC_KEYWORDS = [
  '@ts-ignore',
  '@ts-expect-error',
  '@ts-check',
  '@ts-nocheck',
  'eslint-disable',
  'eslint-enable',
  'global',
  'jshint',
  'istanbul',
  '@flow',
  '@preserve',
  '@license',
  'prettier-ignore'
];

function isMagicComment(comment) {
  return MAGIC_KEYWORDS.some(keyword => comment.includes(keyword));
}

function removeComments(code) {
  // Regex matches:
  // 1. Block comments /* ... */
  // 2. Line comments // ...
  // 3. Double quoted strings " ... "
  // 4. Single quoted strings ' ... '
  // 5. Template literals ` ... `
  // 6. Regular expression literals / ... /
  const regex = /\/\*[\s\S]*?\*\/|\/\/.*|("(?:\\.|[^\\"])*")|('(?:\\.|[^\\'])*')|(\`(?:\\.|[^\\\`])*?\`)|(\/(?:\\(?:\/|.)|[^\\\/\/])+\/[gimyu]*)/g;

  return code.replace(regex, (match, g1, g2, g3, g4) => {
    // If it's a string or regex, return it as is
    if (g1 || g2 || g3 || g4) return match;

    // It's a comment
    if (isMagicComment(match)) return match;

    // Remove non-magic comments
    // For line comments, handle the newline if it was part of the match?
    // //.* doesn't include the newline.
    return '';
  });
}

function processFile(filePath) {
  console.log(`Processing: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  const cleaned = removeComments(content);
  fs.writeFileSync(filePath, cleaned, 'utf8');
}

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

const targets = [
  path.join(ROOT, 'index.js'),
  path.join(ROOT, 'lib'),
  path.join(ROOT, 'features'),
  path.join(ROOT, 'test')
];

targets.forEach(target => {
  if (!fs.existsSync(target)) return;
  if (fs.statSync(target).isDirectory()) {
    walkDir(target, (filePath) => {
      if (filePath.endsWith('.js')) {
        processFile(filePath);
      }
    });
  } else {
    if (target.endsWith('.js')) {
      processFile(target);
    }
  }
});

console.log('Cleanup complete!');
