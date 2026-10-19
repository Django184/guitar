import { describe, expect, it } from 'vitest';
import { AppError, describeError, microphoneError } from '../src/ui/errors';

const domError = (name: string): DOMException => new DOMException('détail technique', name);

describe('Erreurs micro : message clair en français', () => {
  it('micro refusé', () => {
    const error = microphoneError(domError('NotAllowedError'));
    expect(error.code).toBe('mic-denied');
    expect(error.message).toContain('Accès au micro refusé');
  });

  it('micro absent', () => {
    expect(microphoneError(domError('NotFoundError')).code).toBe('mic-missing');
    expect(microphoneError(domError('OverconstrainedError')).code).toBe('mic-missing');
  });

  it('micro occupé par une autre application', () => {
    expect(microphoneError(domError('NotReadableError')).code).toBe('mic-busy');
  });

  it('navigateur sans accès micro', () => {
    expect(microphoneError(domError('NotSupportedError')).code).toBe('mic-unsupported');
  });

  it('erreur inconnue : message générique, jamais le détail technique', () => {
    const error = microphoneError(new Error('boom'));
    expect(error.code).toBe('mic-unknown');
    expect(error.message.includes('boom')).toBe(false);
  });

  it('une AppError garde son code', () => {
    expect(microphoneError(new AppError('mic-insecure')).code).toBe('mic-insecure');
    expect(describeError(new AppError('mic-insecure'))).toContain('https://');
  });
});
