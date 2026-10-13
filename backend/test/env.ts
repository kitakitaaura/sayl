/** A valid minimal environment for tests. */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    QBIT_USERNAME: 'sayl',
    QBIT_PASSWORD: 'correct horse battery',
    SESSION_SECRET: 's'.repeat(64),
    DOWNLOAD_URL_SECRET: 'd'.repeat(64),
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}
