import { makeL1Gateway } from '@ensdomains/l1-gateway';
import { Server } from '@chainlink/ccip-read-server';
import { HardhatEthersProvider } from '@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider';
import type { HardhatEthersHelpers } from '@nomicfoundation/hardhat-ethers/types';
import { expect } from 'chai';
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Signer,
  ethers as ethersT
} from 'ethers';
import { FetchRequest } from 'ethers';
import { ethers } from 'hardhat';
import { EthereumProvider } from 'hardhat/types';
import request from 'supertest';
const node = ethers.namehash('foo.eth')
const EMPTY_ADDRESS = '0x0000000000000000000000000000000000000000'
const EMPTY_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

const labelhash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label))

type ethersObj = typeof ethersT &
  Omit<HardhatEthersHelpers, 'provider'> & {
    provider: Omit<HardhatEthersProvider, '_hardhatProvider'> & {
      _hardhatProvider: EthereumProvider;
    };
  };

declare module 'hardhat/types/runtime' {
  const ethers: ethersObj;
  interface HardhatRuntimeEnvironment {
    ethers: ethersObj;
  }
}

describe('Crosschain Resolver', () => {
  let provider: BrowserProvider;
  let signer: Signer;
  let verifier: Contract;
  let target: Contract;
  let l2contract: Contract;
  let ens: Contract;
  let wrapper: Contract;
  let signerAddress, resolverAddress, wrapperAddress, metaDataserviceAddress

  before(async () => {
    // Hack to get a 'real' ethers provider from hardhat. The default `HardhatProvider`
    // doesn't support CCIP-read.
    provider = new ethers.BrowserProvider(ethers.provider._hardhatProvider);
    // provider.on("debug", (x: any) => console.log(JSON.stringify(x, undefined, 2)));
    signer = await provider.getSigner(0);
    signerAddress = await signer.getAddress()
    const gateway = makeL1Gateway(provider as unknown as JsonRpcProvider);
    const server = new Server()
    gateway.add(server)
    const app = server.makeApp('/')
    const getUrl = FetchRequest.createGetUrlFunc();    
    ethers.FetchRequest.registerGetUrl(async (req: FetchRequest) => {
      if(req.url != "test:") return getUrl(req);

      const r = request(app).post('/');
      if (req.hasBody()) {
        r.set('Content-Type', 'application/json').send(
          ethers.toUtf8String(req.body)
        );
      }
      const response = await r;
      return {
        statusCode: response.statusCode,
        statusMessage: response.ok ? 'OK' : response.statusCode.toString(),
        body: ethers.toUtf8Bytes(JSON.stringify(response.body)),
        headers: {
          'Content-Type': 'application/json',
        },
      };
    });
    const ensFactory = await ethers.getContractFactory('ENSRegistry',signer);
    ens = await ensFactory.deploy();
    const ensAddress = await ens.getAddress()
    const baseRegistrarFactory = await ethers.getContractFactory('BaseRegistrarImplementation',signer);
    const baseRegistrar = await baseRegistrarFactory.deploy(ensAddress,ethers.namehash('eth'))
    const baseRegistrarAddress = await baseRegistrar.getAddress()
    await baseRegistrar.addController(signerAddress)
    const metaDataserviceFactory = await ethers.getContractFactory('StaticMetadataService',signer);
    const metaDataservice = await metaDataserviceFactory.deploy('https://ens.domains')
    const metaDataserviceAddress = await metaDataservice.getAddress()
    const wrapperFactory = await ethers.getContractFactory('NameWrapper',signer);
    const reverseRegistrarFactory = await ethers.getContractFactory('ReverseRegistrar',signer);
    const reverseRegistrar = await reverseRegistrarFactory.deploy(ensAddress)
    const reverseRegistrarAddress = await reverseRegistrar.getAddress()
    await ens.setSubnodeOwner(EMPTY_BYTES32, labelhash('reverse'), signerAddress)
    await ens.setSubnodeOwner(ethers.namehash('reverse'),labelhash('addr'), reverseRegistrarAddress)
    await ens.setSubnodeOwner(EMPTY_BYTES32, labelhash('eth'), signerAddress)
    await ens.setSubnodeOwner(ethers.namehash('eth'), labelhash('foo'), signerAddress)
    const publicResolverFactory = await ethers.getContractFactory('PublicResolver',signer);
    const publicResolver = await publicResolverFactory.deploy(
      ensAddress,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      reverseRegistrarAddress,
    )
    const publicResolverAddress = await publicResolver.getAddress()
    await reverseRegistrar.setDefaultResolver(publicResolverAddress)

    console.log({ensAddress,baseRegistrarAddress, metaDataserviceAddress})
    // wrapper = await wrapperFactory.deploy(
    //   ensAddress,
    //   baseRegistrarAddress,
    //   metaDataserviceAddress
    // );
    // wrapperAddress = await wrapper.getAddress()

    const l1VerifierFactory = await ethers.getContractFactory(
      'L1Verifier',
      signer
    );
    verifier = await l1VerifierFactory.deploy(['test:']);
    const impl = await ethers.getContractFactory(
      'DelegatableResolver',
      signer
    );
    const implContract = await impl.deploy();
    const testL2Factory = await ethers.getContractFactory(
      'DelegatableResolverFactory',
      signer
    );
    const l2factoryContract = await testL2Factory.deploy(await implContract.getAddress());
    const tx = await l2factoryContract.create(await signer.getAddress());
    await provider.send('evm_mine', []);
    await tx.wait()
    const logs = await l2factoryContract.queryFilter("NewDelegatableResolver")
    const [resolver] = logs[0].args
    resolverAddress = resolver
    const testL1Factory = await ethers.getContractFactory(
      'L1Resolver',
      signer
    );
    const verifierAddress = await verifier.getAddress()
    const wrapperAddress = verifierAddress // TODO: Fix wrapper deployment
    target = await testL1Factory.deploy(verifierAddress, ensAddress, wrapperAddress);

    // Mine an empty block so we have something to prove against
    await provider.send('evm_mine', []);
    l2contract = impl.attach(resolverAddress)
    await target.setTarget(node, resolverAddress)

  });

  it("should not allow non owner to set target", async() => {
    const incorrectnode = ethers.namehash('notowned.eth')
    // For some reason expect().to.be.reverted isn't working
    // Throwing Error: missing revert data (action="estimateGas"...
    try{
      await target.setTarget(incorrectnode, resolverAddress)
    }catch(e){
    }

    expect(await target.targets(incorrectnode)).to.equal(EMPTY_ADDRESS);
  })

  it("should test empty ETH Address", async() => {
    const addr = '0x0000000000000000000000000000000000000000'
    await l2contract.clearRecords(node)
    const result = await l2contract['addr(bytes32)'](node)
    expect(ethers.getAddress(result)).to.equal(addr);
    await provider.send("evm_mine", []);
    const result2 = await target['addr(bytes32)'](node, { enableCcipRead: true })
    expect(result2).to.equal(addr);
  })

  it("should test ETH Address", async() => {
    const addr = '0x5A384227B65FA093DEC03Ec34e111Db80A040615'
    await l2contract.clearRecords(node)
    await l2contract['setAddr(bytes32,address)'](node, addr)
    const result = await l2contract['addr(bytes32)'](node)
    expect(ethers.getAddress(result)).to.equal(addr);
    await provider.send("evm_mine", []);
    const result2 = await target['addr(bytes32)'](node, { enableCcipRead: true })
    expect(result2).to.equal(addr);
  })
  it("should test non ETH Address", async() => {
    const addr = '0x76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'
    const coinType = 0 // BTC
    await l2contract.clearRecords(node)
    await l2contract['setAddr(bytes32,uint256,bytes)'](node, coinType, addr)
    const result = await l2contract['addr(bytes32,uint256)'](node, 0)
    expect(result).to.equal(addr);
    await provider.send("evm_mine", []);
    const result2 = await target['addr(bytes32,uint256)'](node, coinType, { enableCcipRead: true })
    expect(result2).to.equal(addr);
  })

  it("should test text record", async() => {
    const key = 'name'
    const value = 'nick.eth'
    await l2contract.clearRecords(node)
    await l2contract.setText(node, key, value)
    await provider.send("evm_mine", []);
    const result = await l2contract.text(node, key)
    expect(result).to.equal(value);
    const result2 = await target.text(node, key, { enableCcipRead: true })
    expect(result2).to.equal(value);
  })

  it("should test contenthash", async() => {
    const contenthash = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
    await l2contract.clearRecords(node)
    await l2contract.setContenthash(node, contenthash)
    await provider.send("evm_mine", []);
    const result = await l2contract.contenthash(node)
    expect(result).to.equal(contenthash);
    const result2 = await target.contenthash(node, { enableCcipRead: true })
    expect(result2).to.equal(contenthash);
  })
});