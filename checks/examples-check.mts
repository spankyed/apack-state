// The parts of apack ported to the kernel, each run as it is written: each checks what every step leaves as it goes,
// and throws where something is not what it says.
import { it } from 'vitest'

for (const name of ['commit', 'search', 'threads', 'views']) {
  it(`examples/${name}.mts runs, and each step leaves what it says`, async () => { await import(`../examples/${name}.mts`) })
}
