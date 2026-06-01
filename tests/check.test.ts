import { describe, expect, it } from 'bun:test';
import { parseSemVerConstraint, renderCandle, semverToNumber } from '../src/semver.js';

describe('SemVer Constraint & Candle Renderer Tests', () => {

  describe('semverToNumber', () => {
    it('should correctly parse standard version strings into positional scores', () => {
      expect(semverToNumber('1.2.3')).toBe(1002003);
      expect(semverToNumber('4.21.0')).toBe(4021000);
      expect(semverToNumber('0.18.2')).toBe(18002);
      expect(semverToNumber('v12.0.0')).toBe(12000000);
    });
  });

  describe('parseSemVerConstraint', () => {
    it('should parse strictly pinned versions', () => {
      const range = parseSemVerConstraint('1.5.0', '1.5.0');
      expect(range.min).toBe('1.5.0');
      expect(range.max).toBe('1.5.0');
      expect(range.type).toBe('pinned');
    });

    it('should parse tilde constraints correctly', () => {
      const range = parseSemVerConstraint('~1.5.0', '1.5.2');
      expect(range.min).toBe('1.5.0');
      expect(range.max).toBe('1.5.999');
      expect(range.type).toBe('tilde');
    });

    it('should parse caret constraints correctly for major version >= 1', () => {
      const range = parseSemVerConstraint('^4.21.0', '4.24.2');
      expect(range.min).toBe('4.21.0');
      expect(range.max).toBe('4.99.99');
      expect(range.type).toBe('caret');
    });

    it('should parse caret constraints correctly for major version 0', () => {
      const range = parseSemVerConstraint('^0.18.2', '0.18.2');
      expect(range.min).toBe('0.18.2');
      expect(range.max).toBe('0.18.99');
      expect(range.type).toBe('caret');
    });

    it('should parse open-ended constraints to infinity', () => {
      const range = parseSemVerConstraint('>=1.0.0', '1.2.0');
      expect(range.min).toBe('1.0.0');
      expect(range.max).toBe('infinity');
      expect(range.type).toBe('open');
    });
  });

  describe('renderCandle', () => {
    it('should render a pinned version candle with flat markers', () => {
      // min = 1.5.0, max = 1.5.0
      const candle = renderCandle('1.5.0', '1.5.0', '1.5.0', '1.5.0', '1.5.0', 10);
      expect(candle).toBe('●         ');
    });

    it('should render a caret candle timeline correctly', () => {
      // min = 4.21.0, first = 4.21.0, pinned = 4.50.0, latest = 4.80.0, max = 4.99.99
      const candle = renderCandle('4.21.0', '4.21.0', '4.50.0', '4.80.0', '4.99.99', 20);
      
      // Starts with left boundary |
      expect(candle[0]).toBe('|');
      // Has active pin ●
      expect(candle.includes('●')).toBe(true);
      // Has drift indicator ░
      expect(candle.includes('░')).toBe(true);
      // Has upstream indicator ═
      expect(candle.includes('═')).toBe(true);
      // Ends with right boundary |
      expect(candle[19]).toBe('|');
    });

    it('should render open-ended infinity candles correctly', () => {
      // min = 1.0.0, first = 1.0.0, pinned = 2.0.0, latest = 2.5.0, max = infinity
      const candle = renderCandle('1.0.0', '1.0.0', '2.0.0', '2.5.0', 'infinity', 20);
      
      expect(candle[0]).toBe('|');
      expect(candle.includes('●')).toBe(true);
      expect(candle.endsWith('►∞')).toBe(true);
    });
  });
});
