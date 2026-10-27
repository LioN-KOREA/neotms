module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  // The source imports siblings as `./Thing.js`, which is what Node's ESM resolver needs and what
  // the bundler expects. Jest resolves from the filesystem, where only `./Thing.ts` exists, so the
  // extension is stripped here. Without this every test fails with "Cannot find module ... .js",
  // which reads like a missing file rather than a resolver mismatch.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
