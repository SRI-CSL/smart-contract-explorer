import path from 'path';
import { State } from '../explore/states';
import { ExecutorFactory } from '../explore/execute';
import { LimiterFactory, StateCountLimiterFactory } from '../explore/limiter';
import { Explorer, Transition } from '../explore/explorer';
import { Metadata } from '../frontend/metadata';
import * as Compile from '../frontend/compile';
import { Debugger } from '../utils/debug';
import * as Chain from '../utils/chain';
import { getProductSeedFeatures, } from './product';
import { SimulationExamplesContract, SimulationContractInfo, ContractInfo } from './contract';
import * as Pie from './pie';

const debug = Debugger(__filename);

interface Parameters {
    paths: {
        source: string;
        target: string;
    },
    output: ContractInfo
}

interface Result extends SimulationContractInfo {
    fields: string[];
    seedFeatures: string[];
}

type Kind = 'positive' | 'negative';

export type AbstractExample = {
    id: {
        contract: string;
        method: string;
    }
}

export type SimulationExample = {
    source: State;
    target: State;
    kind: Kind;
};

export class Examples {
    explorer: Explorer;

    constructor(chain: Chain.BlockchainInterface) {
        const { accounts } = chain;
        const factory = new ExecutorFactory(chain);
        this.explorer = new Explorer(factory, accounts);
    }

    async * simulationExamples(source: Metadata, target: Metadata, limiters: LimiterFactory): AsyncIterable<SimulationExample> {
        const context = new Context();
        const workList: SimulationExample[] = [];

        debug(`exploring source states`);

        for await (const transition of this.explorer.transitions({ metadata: source, limiters })) {
            context.addSource(transition);
        }

        debug(`exploring target states`);

        for await (const transition of this.explorer.transitions({ metadata: target, limiters })) {
            const { post: t } = transition;
            context.addTarget(transition);

            for (const s of context.getSourceTraceEquivalent(t))
                yield { source: s, target: t, kind: 'positive' };

            for (const s of context.getSourceObservationDistinct(t))
                workList.push({ source: s, target: t, kind: 'negative' });
        }

        debug(`generated positive examples`);

        while (workList.length > 0) {
            const example = workList.shift()!;
            yield example;

            for (const pred of context.getNewJointPredecessors(example))
                workList.push(pred);
        }

        debug(`generated negative examples`);
    }

    static async generate(parameters: Parameters): Promise<Result> {
        const { paths, output: info } = parameters;
        const source = await Compile.fromFile(paths.source);
        const target = await Compile.fromFile(paths.target);
        const contract = new SimulationExamplesContract(source, target, info, Examples.getExamples);
        const { metadata, examples } = await contract.get();

        const fields = [
            ...Pie.fields(source).map(f => `${source.name}.${f}`),
            ...Pie.fields(target).map(f => `${target.name}.${f}`)
        ];
        const seedFeatures = getProductSeedFeatures(source, target).map(([f,_]) => f);
        return { metadata, examples, fields, seedFeatures };
    }

    static async * getExamples(source: Metadata, target: Metadata): AsyncIterable<SimulationExample> {
        const chain = await Chain.get();
        const examples = new Examples(chain);
        const limiters = new StateCountLimiterFactory(5);
        for await (const example of examples.simulationExamples(source, target, limiters))
            yield example;
    }
}

class Context {
    traces: Map<string, Set<State>>;
    observations: Map<string, Set<State>>;
    predecessorStates: Map<State, Map<string, Set<State>>>;
    exploredPairs: Map<State, Set<State>>;

    constructor() {
        this.traces = new Map<string, Set<State>>();
        this.observations = new Map<string, Set<State>>();
        this.predecessorStates = new Map<State, Map<string, Set<State>>>();
        this.exploredPairs = new Map<State, Set<State>>();
    }

    addSource(transition: Transition): void {
        const { post } = transition;
        this.addSourceState(post);
        this.addTransition(transition);
    }

    addSourceState(state: State): void {
        const traceString = state.trace.toString();
        if (!this.traces.has(traceString))
            this.traces.set(traceString, new Set<State>());
        this.traces.get(traceString)!.add(state);

        const observationString = state.observation.toString();
        if (!this.observations.has(observationString))
            this.observations.set(observationString, new Set<State>());
        this.observations.get(observationString)!.add(state);
    }

    addTarget(transition: Transition): void {
        this.addTransition(transition);
    }

    addTransition(transition: Transition): void {
        const { pre, post, operation } = transition;

        if (pre === undefined || operation === undefined)
            return;

        const op = operation.toString();

        if (this.predecessorStates.get(post) === undefined)
            this.predecessorStates.set(post, new Map<string,Set<State>>());

        if (this.predecessorStates.get(post)!.get(op) === undefined)
            this.predecessorStates.get(post)!.set(op, new Set<State>());

        this.predecessorStates.get(post)!.get(op)!.add(pre);
    }

    getSourceTraceEquivalent(state: State): Iterable<State> {
        const traceString = state.trace.toString();
        return this.traces.get(traceString) || [];
    }

    * getSourceObservationDistinct(state: State): Iterable<State> {
        const observationString = state.observation.toString();
        for (const [obs, states] of this.observations.entries()) {
            if (obs === observationString)
                continue;
            for (const state of states)
                yield state;
        }
    }

    getPredecessorOperations(state: State): Iterable<string> {
        const map = this.predecessorStates.get(state);
        return map === undefined ? [] : map.keys();
    }

    getPredecessorStates(state: State, operation: string): Iterable<State> {
        const map = this.predecessorStates.get(state);
        return map === undefined ? [] : map.get(operation) || [];
    }

    * getNewJointPredecessors(example: SimulationExample): Iterable<SimulationExample> {
        const { source: s, target: t, kind } = example;

        for (const op of this.getPredecessorOperations(s)) {
            for (const sp of this.getPredecessorStates(s, op)) {
                for (const tp of this.getPredecessorStates(t, op)) {

                    if (!this.exploredPairs.has(sp))
                        this.exploredPairs.set(sp, new Set<State>());

                    if (this.exploredPairs.get(sp)!.has(tp))
                        continue;

                    yield { source: sp, target: tp, kind };
                    this.exploredPairs.get(sp)!.add(tp);
                }
            }
        }
    }

}
