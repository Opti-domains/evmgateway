import { Request as CFWRequest } from '@cloudflare/workers-types';
import { Server } from '@ensdomains/ccip-read-cf-worker';
import type { Router } from '@ensdomains/evm-gateway';
import { InMemoryBlockCache } from './blockCache/InMemoryBlockCache.js';
import { Tracker } from './tracker';
interface Env {
  L1_PROVIDER_URL: string;
  L2_PROVIDER_URL: string;
  L2_ROLLUP: string;
}

const tracker = new Tracker('arb-gateway-worker.ens-cf.workers.dev', {enableLogging:true});
const logResult = async (request:CFWRequest, result: Response) => {
  console.log({request, result})
  if (!result.body) {
    return result;
  }
  const [streamForLog, streamForResult] = result.body.tee();
  const logResult = await new Response(streamForLog).json();

  await tracker.trackEvent(
    'result',
    request,
    { props: { result: logResult.data.substring(0, 200) } },
    true
  );
  return new Response(streamForResult, result);
};

let app: Router;
async function fetchGateway(request: CFWRequest, env: Env) {
  // Loading libraries dynamically as a temp work around.
  // Otherwise, deployment thorws "Error: Script startup exceeded CPU time limit." error
  if (!app) {
    const ethers = await import('ethers');

    const EVMGateway = (await import('@ensdomains/evm-gateway')).EVMGateway;
    const ArbProofService = (await import('./ArbProofService.js'))
      .ArbProofService;
    // Set PROVIDER_URL under .dev.vars locally. Set the key as secret remotely with `wrangler secret put WORKER_PROVIDER_URL`
    const { L1_PROVIDER_URL, L2_PROVIDER_URL, L2_ROLLUP } = env;

    const l1Provider = new ethers.JsonRpcProvider(L1_PROVIDER_URL);
    const l2Provider = new ethers.JsonRpcProvider(L2_PROVIDER_URL);

    console.log({ L1_PROVIDER_URL, L2_PROVIDER_URL });
    const gateway = new EVMGateway(
      new ArbProofService(
        l1Provider,
        l2Provider,
        L2_ROLLUP,
        new InMemoryBlockCache()
      )
    );

    const server = new Server();
    gateway.add(server);
    app = server.makeApp('/');
  }
  return app.handle(request).then(logResult.bind(this, request));
}

export default {
  fetch:fetchGateway,
};
