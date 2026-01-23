/**
 * Tests for Local LLM (Embedding Model)
 * 
 * Tests the embedding model functionality including:
 * - Model loading
 * - Embedding generation
 * - Vector properties
 * - Similarity calculations
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { pipeline } from '@xenova/transformers';
import { cosineSimilarity } from '../lib/utils.js';
import { loadConfig } from '../lib/config.js';

describe('Local Embedding Model', () => {
  let embedder;
  let config;
  
  beforeAll(async () => {
    config = await loadConfig();
    console.log(`[Test] Loading embedding model: ${config.embeddingModel}`);
    embedder = await pipeline('feature-extraction', config.embeddingModel);
    console.log('[Test] Embedding model loaded successfully');
  });

  describe('Model Loading', () => {
    it('should load the embedding model', () => {
      expect(embedder).toBeDefined();
      expect(typeof embedder).toBe('function');
    });
    
    it('should use the configured model', () => {
      expect(config.embeddingModel).toBe('jinaai/jina-embeddings-v2-base-code');
    });
  });

  describe('Embedding Generation', () => {
    it('should generate embeddings for text', async () => {
      const text = 'Hello, world!';
      const output = await embedder(text, { pooling: 'mean', normalize: true });
      
      expect(output).toBeDefined();
      expect(output.data).toBeDefined();
    });
    
    it('should return vectors of correct dimensions', async () => {
      const text = 'Test input for embedding';
      const output = await embedder(text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      
      // Jina v2 base code produces 768-dimensional vectors
      expect(vector.length).toBe(768);
    });
    
    it('should return normalized vectors', async () => {
      const text = 'Normalized vector test';
      const output = await embedder(text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      
      // Calculate magnitude (should be ~1 for normalized vectors)
      const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 4);
    });
    
    it('should generate different embeddings for different text', async () => {
      const output1 = await embedder('apple fruit', { pooling: 'mean', normalize: true });
      const output2 = await embedder('programming code', { pooling: 'mean', normalize: true });
      
      const vector1 = Array.from(output1.data);
      const vector2 = Array.from(output2.data);
      
      // Vectors should be different
      const areSame = vector1.every((v, i) => Math.abs(v - vector2[i]) < 0.0001);
      expect(areSame).toBe(false);
    });
    
    it('should handle code snippets', async () => {
      const code = `
        function add(a, b) {
          return a + b;
        }
      `;
      
      const output = await embedder(code, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      
      expect(vector.length).toBe(768);
    });
    
    it('should handle multiline text', async () => {
      const multiline = 'Line one\nLine two\nLine three';
      const output = await embedder(multiline, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      
      expect(vector.length).toBe(768);
    });
    
    it('should handle special characters', async () => {
      const special = '{}[]()<>!@#$%^&*';
      const output = await embedder(special, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      
      expect(vector.length).toBe(768);
    });
  });

  describe('Semantic Similarity', () => {
    it('should give high similarity for semantically similar text', async () => {
      const output1 = await embedder('user authentication login', { pooling: 'mean', normalize: true });
      const output2 = await embedder('user login authentication', { pooling: 'mean', normalize: true });
      
      const vector1 = Array.from(output1.data);
      const vector2 = Array.from(output2.data);
      
      const similarity = cosineSimilarity(vector1, vector2);
      
      // Same words, different order - should be very similar
      expect(similarity).toBeGreaterThan(0.9);
    });
    
    it('should give lower similarity for different topics', async () => {
      const output1 = await embedder('database query SQL', { pooling: 'mean', normalize: true });
      const output2 = await embedder('pizza delivery food', { pooling: 'mean', normalize: true });
      
      const vector1 = Array.from(output1.data);
      const vector2 = Array.from(output2.data);
      
      const similarity = cosineSimilarity(vector1, vector2);
      
      // Different topics - should have low similarity
      expect(similarity).toBeLessThan(0.7); // Relaxed for Jina which might have different distribution
    });
    
    it('should capture code semantic similarity', async () => {
      const output1 = await embedder('function that handles user login', { pooling: 'mean', normalize: true });
      const output2 = await embedder('async authenticate(user, password)', { pooling: 'mean', normalize: true });
      const output3 = await embedder('function to sort array elements', { pooling: 'mean', normalize: true });
      
      const v1 = Array.from(output1.data);
      const v2 = Array.from(output2.data);
      const v3 = Array.from(output3.data);
      
      const sim12 = cosineSimilarity(v1, v2); // login-related
      const sim13 = cosineSimilarity(v1, v3); // login vs sorting
      
      // Login concepts should be more similar to each other than to sorting
      expect(sim12).toBeGreaterThan(sim13);
    });
    
    it('should recognize programming language constructs', async () => {
      const output1 = await embedder('import React from "react"', { pooling: 'mean', normalize: true });
      const output2 = await embedder('import Vue from "vue"', { pooling: 'mean', normalize: true });
      const output3 = await embedder('The weather is sunny today', { pooling: 'mean', normalize: true });
      
      const v1 = Array.from(output1.data);
      const v2 = Array.from(output2.data);
      const v3 = Array.from(output3.data);
      
      const sim12 = cosineSimilarity(v1, v2); // Both imports
      const sim13 = cosineSimilarity(v1, v3); // Import vs weather
      
      // Import statements should be more similar to each other
      expect(sim12).toBeGreaterThan(sim13);
    });
  });

  describe('Cosine Similarity Function', () => {
    it('should return 1 for identical vectors', () => {
      const vector = [0.1, 0.2, 0.3, 0.4, 0.5];
      expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 5);
    });
    
    it('should return -1 for opposite vectors', () => {
      const vector1 = [1, 0, 0];
      const vector2 = [-1, 0, 0];
      expect(cosineSimilarity(vector1, vector2)).toBeCloseTo(-1, 5);
    });
    
    it('should return 0 for orthogonal vectors', () => {
      const vector1 = [1, 0, 0];
      const vector2 = [0, 1, 0];
      expect(cosineSimilarity(vector1, vector2)).toBeCloseTo(0, 5);
    });
    
    it('should handle high-dimensional vectors', () => {
      const dim = 768;
      const vector1 = Array(dim).fill(0).map(() => Math.random());
      const vector2 = Array(dim).fill(0).map(() => Math.random());
      
      const similarity = cosineSimilarity(vector1, vector2);
      
      expect(similarity).toBeGreaterThanOrEqual(-1);
      expect(similarity).toBeLessThanOrEqual(1);
    });
  });

  describe('Performance', () => {
    it('should generate embeddings in reasonable time', async () => {
      const text = 'This is a test sentence for measuring embedding generation speed.';
      
      const start = Date.now();
      await embedder(text, { pooling: 'mean', normalize: true });
      const duration = Date.now() - start;
      
      // Should be fast (under 500ms for single embedding)
      expect(duration).toBeLessThan(500);
    });
    
    it('should handle multiple sequential embeddings', async () => {
      const texts = [
        'First test input',
        'Second test input',
        'Third test input',
        'Fourth test input',
        'Fifth test input'
      ];
      
      const start = Date.now();
      for (const text of texts) {
        await embedder(text, { pooling: 'mean', normalize: true });
      }
      const duration = Date.now() - start;
      
      // 5 embeddings should complete in reasonable time
      expect(duration).toBeLessThan(2500);
      console.log(`[Test] 5 embeddings generated in ${duration}ms (${(duration/5).toFixed(0)}ms avg)`);
    });
  });
});
