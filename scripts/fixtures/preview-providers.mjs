/** Development-only transport adapters for the real AppShell. */
export default {
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
            : `import { getFunctionName } from 'convex/server'; const resultCache = new Map(); export const useConvexAuth=()=>({isAuthenticated:false,isLoading:false}); export const useQuery=()=>undefined; export const useQuery_experimental=({query,args})=>{const name=getFunctionName(query); const data=globalThis.__appPreviewQueryResults?.[name]; if(args==='skip'||data===undefined)return {status:'pending'}; if(resultCache.get(name)?.data!==data)resultCache.set(name,{status:'success',data});return resultCache.get(name)}; export const useMutation=()=>async()=>{throw Error('No real mutations in preview')}; export const useAction=useMutation; export const usePaginatedQuery=()=>({results:[],status:'Exhausted',loadMore:()=>{}}); export const useConvex=()=>({query:async()=>[],mutation:async()=>{throw Error('No mutations')}});`,
    }));
  },
};
