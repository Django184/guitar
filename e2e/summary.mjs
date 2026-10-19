// Résumé des tests de bout en bout pour la CI : une annotation lisible dans l'onglet
// « Checks » de GitHub (et via l'API), plus le résumé de l'exécution.
import fs from 'node:fs';

const file = process.argv[2] ?? 'e2e-results.json';
if (!fs.existsSync(file)) {
  console.log(`::warning title=Playwright::${file} introuvable`);
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
const measures = [];
const skipped = [];
const unstable = [];

function walk(suite, titles = []) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const status = test.status === 'expected' ? 'passed' : test.status === 'unexpected' ? 'failed' : test.status;
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === 'skipped') skipped.push(`[${test.projectName}] ${spec.title}`);
      if (status === 'flaky' || status === 'failed') {
        // Premier message d'erreur, sur une ligne, pour diagnostiquer sans télécharger le rapport.
        const error = (test.results ?? []).flatMap((r) => r.errors ?? []).find((e) => e.message);
        const lines = (error?.message ?? '')
          .replace(/\u001b\[[0-9;]*m/g, '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 3)
          .join(' / ');
        const where = error?.location ? ` (${error.location.file.split('/').pop()}:${error.location.line})` : '';
        unstable.push(`[${test.projectName}] ${spec.title} (${status})${where} : ${lines.slice(0, 300)}`);
      }
      for (const result of test.results ?? []) {
        for (const a of [...(result.annotations ?? []), ...(test.annotations ?? [])]) {
          if (a.type === 'mesure') measures.push(`[${test.projectName}] ${a.description}`);
        }
      }
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
}
for (const suite of report.suites ?? []) walk(suite);

const line = `${counts.passed} réussis, ${counts.failed} échoués, ${counts.flaky} instables, ${counts.skipped} ignorés`;
const details = [...new Set(measures)].join(' ; ');
console.log(`::notice title=Playwright::${line}${details ? ` | ${details}` : ''}`);
if (skipped.length) console.log(`::warning title=Tests ignorés::${skipped.join(' ; ')}`);
for (const u of unstable) console.log(`::warning title=Test échoué ou instable::${u}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    '## Tests de bout en bout',
    '',
    `**${line}**`,
    '',
    ...[...new Set(measures)].map((m) => `- ${m}`),
    ...(skipped.length ? ['', '### Ignorés', ...skipped.map((s) => `- ${s}`)] : []),
    ...(unstable.length ? ['', '### Échoués ou instables', ...unstable.map((u) => `- ${u}`)] : []),
    '',
  ].join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
