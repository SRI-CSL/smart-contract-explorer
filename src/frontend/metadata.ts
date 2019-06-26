import { ABIDefinition } from 'web3/eth/abi';
import Contract from 'web3/eth/contract';
import { SourceUnit, ContractMember } from './ast';

export type Contract = Contract;

export type Address = string;
export type Method = ABIDefinition;

export namespace Method {
    export function equals(m1: Method, m2: Method): boolean {
        return JSON.stringify(m1) === JSON.stringify(m2);
    }
}

export interface SourceInfo {
    path: string;
    content: string;
}

export interface Metadata {
    name: string;
    source: SourceInfo;
    abi: Method[];
    bytecode: string;
    userdoc: object;
    ast: SourceUnit;
    members: ContractMember[];
}