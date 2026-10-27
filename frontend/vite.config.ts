import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' prefix: read every variable, not only VITE_*. NEOTMS_DEV_API_TARGET is dev-server config
  // and must NOT reach client code, which is exactly what a VITE_ prefix would do.
  const env = loadEnv(mode, process.cwd(), '')
  const devApiTarget = env.NEOTMS_DEV_API_TARGET?.replace(/\/+$/, '')

  if (mode === 'development' && !devApiTarget) {
    console.warn(
      '\n[neotms] NEOTMS_DEV_API_TARGET is not set, so /api/* requests from `npm run dev` will 404.\n' +
        '         Put the deployed console URL (the ConsoleUrl stack output) in frontend/.env.local:\n' +
        '           NEOTMS_DEV_API_TARGET=https://dxxxxxxxxxxxxx.cloudfront.net\n',
    )
  }

  return {
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
    resolve: {
      // Keep in sync with the "paths" entry in tsconfig.app.json.
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      // The CDK BucketDeployment uploads this directory as-is; NeotmsSite looks for
      // frontend/dist/index.html to decide whether a build exists at all.
      outDir: 'dist',
      sourcemap: true,
    },
    server: {
      /*
       * The console calls the API with relative paths (/api/...), exactly as it does in production
       * where one CloudFront distribution serves both. In dev this proxy plays CloudFront's part,
       * so the code has a single form and there is no dev/prod URL switch to get wrong.
       *
       * This is not a convenience. The session cookie is `SameSite=Lax` with `Path=/api/auth`, so
       * a cross-site `POST /api/auth/refresh` would not carry it and the console would sign itself
       * out roughly once an hour with no error anywhere. Same-origin in dev too is what makes the
       * dev setup actually exercise the production cookie behaviour.
       *
       * The cookie survives the hop: it has no Domain attribute, so the browser stores it against
       * localhost, and browsers treat http://localhost as a secure context so its Secure flag is
       * accepted. The Origin header (http://localhost:5173) passes through untouched - which is
       * why that exact origin is on `allowedOriginUrls` in NeotmsConfig.
       */
      proxy: devApiTarget
        ? {
            '/api': {
              target: devApiTarget,
              // Rewrites Host to the target's. Without it CloudFront receives
              // `Host: localhost:5173` and rejects the request before it reaches the API.
              changeOrigin: true,
              secure: true,
            },
          }
        : undefined,
    },
  }
})
