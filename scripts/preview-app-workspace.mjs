/** Loopback actual-app acceptance. Only transport/providers are stubbed. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { build, file, serve } from 'bun';
import postcss from 'postcss';

const root = process.cwd();
const result = await build({
  entrypoints: [resolve(root, 'scripts/fixtures/app-workspace-preview.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
  plugins: [
    {
      name: 'synthetic-providers',
      setup(builder) {
        builder.onResolve({ filter: /^(next\/navigation|convex\/react|@clerk\/nextjs)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          loader: 'js',
          contents:
            path === 'next/navigation'
              ? `export const useRouter=()=>({push:(url)=>{history.pushState(null,'',url);dispatchEvent(new PopStateEvent('popstate'))},replace:(url)=>history.replaceState(null,'',url),refresh:()=>{}}); export const usePathname=()=>'/'; export const useSearchParams=()=>new URLSearchParams(location.search); export const useParams=()=>({}); export const redirect=(url)=>{throw Error('Synthetic redirect: '+url)}; export const RedirectType={push:'push',replace:'replace'};`
              : path === '@clerk/nextjs'
                ? `export const UserButton=()=>null; export const useUser=()=>({user:null,isLoaded:true,isSignedIn:false}); export const useAuth=()=>({isLoaded:true,isSignedIn:false,getToken:async()=>null}); export const useClerk=()=>({}); export const ClerkProvider=({children})=>children; export const SignedIn=()=>null; export const SignedOut=({children})=>children; export const SignInButton=({children})=>children;`
                : `export const useConvexAuth=()=>({isAuthenticated:false,isLoading:false}); export const useQuery=()=>undefined; export const useQuery_experimental=()=>({status:'pending'}); export const useMutation=()=>async()=>{throw Error('No real mutations in preview')}; export const useAction=useMutation; export const usePaginatedQuery=()=>({results:[],status:'Exhausted',loadMore:()=>{}}); export const useConvex=()=>({query:async()=>[],mutation:async()=>{throw Error('No mutations')}});`,
        }));
      },
    },
  ],
});
if (!result.success) throw new Error(result.logs.map(String).join('\n'));
const script = await result.outputs.find((output) => output.path.endsWith('.js')).text();
const componentCss = (
  await Promise.all(
    result.outputs.filter((output) => output.path.endsWith('.css')).map((output) => output.text()),
  )
).join('\n');
const cssPath = resolve(root, 'app/globals.css');
const css = await postcss([tailwindcss({ base: root })]).process(await readFile(cssPath, 'utf8'), {
  from: cssPath,
});
const chunks = resolve(root, '.next/static/chunks');
const compiledCss = (
  await Promise.all(
    (
      await readdir(chunks)
    )
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFile(resolve(chunks, name), 'utf8')),
  )
).join('\n');
const fontFaces = [...compiledCss.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]).join('\n');
const fontVariables = [
  ...compiledCss.matchAll(/--font-(?:geist-sans|geist-mono|fraunces|averia|instrument):[^;}]+/g),
]
  .map((match) => match[0])
  .join(';');
const styles = `${fontFaces}\n${css.css}\n${componentCss}\n:root{${fontVariables}}`;
const server = serve({
  hostname: '127.0.0.1',
  port: 18847,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css') return new Response(styles, { headers: { 'content-type': 'text/css' } });
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Albatross actual workspace · synthetic acceptance</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Actual AppShell synthetic preview: ${server.url}`);
