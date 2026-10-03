import { runContractSuite } from '../contract/run-contract-suite.mjs';
import { createD1Harness } from './d1-harness.mjs';

// Exactly the same registrations and fixtures as the memory and SQLite adapters.
runContractSuite(createD1Harness);
