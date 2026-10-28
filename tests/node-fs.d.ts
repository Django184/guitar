/**
 * Seule fonction de Node utilisée par les tests unitaires (lecture des vidéos de test) : le
 * tsconfig principal n'inclut pas @types/node, réservé aux tests de bout en bout.
 */
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
}
