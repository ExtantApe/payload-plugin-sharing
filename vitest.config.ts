import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // One copy of graphql for the GraphQL refusal tests: Payload's schema and the test must share it.
    server: { deps: { inline: ['graphql', '@payloadcms/graphql'] } },
  },
})
