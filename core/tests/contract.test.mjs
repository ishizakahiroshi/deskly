import { runContractSuite } from './contract/run-contract-suite.mjs';
import { createMemoryHarness } from './contract/memory-harness.mjs';

runContractSuite(createMemoryHarness);
