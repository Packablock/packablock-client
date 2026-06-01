import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { parseLockfiles } from '../src/lockfile.js';
import { computeDiff } from '../src/diff.js';

describe('Lockfile Parser & Diff Tests', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  describe('Bun (Legacy JSON format)', () => {
    it('should parse Bun legacy lockfile Iteration 1 correctly', () => {
      const result = parseLockfiles([path.join(fixturesDir, 'bun-v1.json')]);
      expect(result.packages).toEqual({
        lodash: '4.17.21',
        zod: '3.22.4',
      });
      expect(result.source).toBe('bun-v1.json');
    });

    it('should parse Bun legacy lockfile Iteration 2 correctly', () => {
      const result = parseLockfiles([path.join(fixturesDir, 'bun-v2.json')]);
      expect(result.packages).toEqual({
        commander: '11.1.0',
        lodash: '4.17.22',
        zod: '3.22.4',
      });
      expect(result.source).toBe('bun-v2.json');
    });

    it('should compute the correct diff between Bun Iteration 1 and 2 packages', () => {
      const v1 = parseLockfiles([path.join(fixturesDir, 'bun-v1.json')]);
      const v2 = parseLockfiles([path.join(fixturesDir, 'bun-v2.json')]);

      const yaml1 = JSON.stringify(v1.packages, null, 2);
      const yaml2 = JSON.stringify(v2.packages, null, 2);

      const diff = computeDiff(yaml1, yaml2);

      // Verify that LODASH version changed and COMMANDER was added
      const addedLines = diff.filter(line => line.type === 'added').map(line => line.text.trim());
      const removedLines = diff.filter(line => line.type === 'removed').map(line => line.text.trim());

      expect(addedLines).toContain('"commander": "11.1.0",');
      expect(addedLines).toContain('"lodash": "4.17.22",');
      expect(removedLines).toContain('"lodash": "4.17.21",');
    });
  });

  describe('Yarn (.lock format)', () => {
    it('should parse Yarn lockfile Iteration 1 correctly', () => {
      const result = parseLockfiles([path.join(fixturesDir, 'yarn-v1.lock')]);
      expect(result.packages).toEqual({
        lodash: '4.17.21',
      });
    });

    it('should parse Yarn lockfile Iteration 2 correctly', () => {
      const result = parseLockfiles([path.join(fixturesDir, 'yarn-v2.lock')]);
      expect(result.packages).toEqual({
        lodash: '4.17.22',
        zod: '3.22.4',
      });
    });
  });

  describe('NPM (package-lock.json v3 format)', () => {
    it('should parse NPM package-lock.json v3 Iteration 1 correctly', () => {
      const result = parseLockfiles([path.join(fixturesDir, 'npm-v1.json')]);
      expect(result.packages).toEqual({
        accepts: '1.3.8',
        express: '4.18.2',
      });
    });

    it('should parse NPM package-lock.json v3 Iteration 2 correctly', () => {
      const result = parseLockfiles([path.join(fixturesDir, 'npm-v2.json')]);
      expect(result.packages).toEqual({
        accepts: '1.3.9',
        express: '4.19.2',
      });
    });
  });
});
