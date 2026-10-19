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

function walk(suite, titles = []) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const status = test.status === 'expected' ? 'passed' : test.status === 'unexpected' ? 'failed' : test.status;
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === 'skipped') skipped.push(`[${test.projectName}] ${spec.title}`);
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

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    '## Tests de bout en bout',
    '',
    `**${line}**`,
    '',
    ...[...new Set(measures)].map((m) => `- ${m}`),
    ...(skipped.length ? ['', '### Ignorés', ...skipped.map((s) => `- ${s}`)] : []),
    '',
  ].join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
