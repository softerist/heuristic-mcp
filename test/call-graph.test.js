import { describe, it, expect } from 'vitest';
import { extractCallData, extractDefinitions, extractCalls, buildCallGraph, getRelatedFiles } from '../lib/call-graph.js';

describe('Call Graph Extractor', () => {
  describe('extractDefinitions', () => {
    it('should extract JavaScript function declarations', () => {
      const content = `
        function foo() {}
        async function bar() {}
        const baz = () => {};
        let qux = async () => {};
      `;
      const defs = extractDefinitions(content, 'test.js');
      expect(defs).toContain('foo');
      expect(defs).toContain('bar');
      expect(defs).toContain('baz');
      expect(defs).toContain('qux');
    });

    it('should extract JavaScript class declarations', () => {
      const content = `
        class MyClass {
          myMethod() {}
        }
      `;
      const defs = extractDefinitions(content, 'test.js');
      expect(defs).toContain('MyClass');
      expect(defs).toContain('myMethod');
    });

    it('should extract Python definitions', () => {
      const content = `
        def my_function():
            pass

        class MyClass:
            def method(self):
                pass
      `;
      const defs = extractDefinitions(content, 'test.py');
      expect(defs).toContain('my_function');
      expect(defs).toContain('MyClass');
      expect(defs).toContain('method');
    });

    it('should extract Go function declarations', () => {
      const content = `
        func main() {}
        func (s *Server) Start() {}
      `;
      const defs = extractDefinitions(content, 'test.go');
      expect(defs).toContain('main');
      expect(defs).toContain('Start');
    });
  });

  describe('extractCalls', () => {
    it('should extract function calls', () => {
      const content = `
        function main() {
          foo();
          bar.baz();
          await asyncFunc();
        }
      `;
      const calls = extractCalls(content, 'test.js');
      expect(calls).toContain('foo');
      expect(calls).toContain('baz'); // bar.baz() -> extracts 'baz'
      expect(calls).toContain('asyncFunc');
    });

    it('should exclude built-in keywords', () => {
      const content = `
        if (condition) {}
        for (let i = 0; i < 10; i++) {}
        while (true) {}
      `;
      const calls = extractCalls(content, 'test.js');
      expect(calls).not.toContain('if');
      expect(calls).not.toContain('for');
      expect(calls).not.toContain('while');
    });

    it('should not extract calls from strings', () => {
      const content = `
        const str = "someFunction()";
        const template = \`anotherFunction()\`;
      `;
      const calls = extractCalls(content, 'test.js');
      expect(calls).not.toContain('someFunction');
      expect(calls).not.toContain('anotherFunction');
    });
  });

  describe('extractCallData', () => {
    it('should separate definitions from external calls', () => {
      const content = `
        function localFunc() {
          externalFunc();
          localFunc(); // self-reference
        }
      `;
      const result = extractCallData(content, 'test.js');
      expect(result.definitions).toContain('localFunc');
      expect(result.calls).toContain('externalFunc');
      expect(result.calls).not.toContain('localFunc'); // Filtered as self-reference
    });
  });

  describe('buildCallGraph', () => {
    it('should build graph from file data', () => {
      const fileData = new Map([
        ['/path/a.js', { definitions: ['funcA'], calls: ['funcB'] }],
        ['/path/b.js', { definitions: ['funcB'], calls: ['funcC'] }],
        ['/path/c.js', { definitions: ['funcC'], calls: [] }]
      ]);

      const graph = buildCallGraph(fileData);

      expect(graph.defines.get('funcA')).toContain('/path/a.js');
      expect(graph.defines.get('funcB')).toContain('/path/b.js');
      expect(graph.calledBy.get('funcB')).toContain('/path/a.js');
      expect(graph.calledBy.get('funcC')).toContain('/path/b.js');
    });
  });

  describe('getRelatedFiles', () => {
    it('should find callers and callees', () => {
      const fileData = new Map([
        ['/path/a.js', { definitions: ['funcA'], calls: ['funcB'] }],
        ['/path/b.js', { definitions: ['funcB'], calls: [] }]
      ]);

      const graph = buildCallGraph(fileData);
      const related = getRelatedFiles(graph, ['funcB'], 1);

      // funcB is defined in b.js and called by a.js
      expect(related.has('/path/a.js')).toBe(true);
      expect(related.has('/path/b.js')).toBe(true);
    });
  });
});
