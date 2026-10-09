import { describe, expect, it } from 'vitest';
import { stripControl } from '../src/text.js';

describe('stripControl', () => {
  it('removes C0/C1 controls and bidi overrides, keeps the visible text', () => {
    expect(stripControl('Op\u001b]52;c;ZXZpbA==\u0007us')).toBe('Op]52;c;ZXZpbA==us');
    expect(stripControl('Chat\rFAKE\nline\u009b31m')).toBe('ChatFAKEline31m');
    expect(stripControl('abc\u202edcba\u2066x\u2069')).toBe('abcdcbax');
    expect(stripControl('Sessão atual · só Opus 4.5 — ok')).toBe('Sessão atual · só Opus 4.5 — ok');
  });
});
