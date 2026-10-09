import { existsSync, rmSync } from 'node:fs';
import { databasePath, Repository } from './repository';

const path = databasePath();
if (existsSync(path)) rmSync(path);
const repository = new Repository(path);
repository.seed();
repository.close();
console.log('Synthetic case data reset.');
