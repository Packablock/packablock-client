#!/usr/bin/env bun
import { createCli } from './src/cli.js';

const program = createCli();
program.parse(process.argv);