import { describe, expect, it } from 'vitest'
import { sharing } from '../src/index.js'

describe('sharing', () => {
  it('leaves a config unchanged while it is a skeleton, and when turned off', () => {
    const config = { collections: [], secret: 'made-up' } as never
    expect(sharing()(config)).toEqual(config)
    expect(sharing({ enabled: false })(config)).toBe(config)
  })
})
