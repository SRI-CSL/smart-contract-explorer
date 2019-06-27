import { State, Operation } from '../explore/states';
import { ExecutorFactory } from '../explore/execute';
import { LimiterFactory, StateCountLimiterFactory } from '../explore/limiter';
import { Explorer, Transition } from '../explore/explorer';
import { Metadata } from '../frontend/metadata';
import * as Compile from '../frontend/compile';
import { Debugger } from '../utils/debug';
import * as Chain from '../utils/chain';

const debug = Debugger(__filename);

interface Parameters {
    sourceFilename: string;
    targetFilename: string;
}

interface Result {
    metadata: Metadata;
    names: string[];
}

type Kind = 'positive' | 'negative';

type SimulationExample = {
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
        const { sourceFilename, targetFilename } = parameters;
        const source = await Compile.fromFile(sourceFilename);
        const target = await Compile.fromFile(targetFilename);
        const contract = new Contract(source, target);
        const result = await contract.get();
        return result;
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

class Contract {
    constructor(public source: Metadata, public target: Metadata) { }

    async get(): Promise<Result> {
        const methods: { name: string, content: string }[] = [];

        for await (const example of Examples.getExamples(this.source, this.target)) {
            const { kind } = example;
            const name = `${kind}Example${methods.length}`;
            const content = this.methodForExample(example, name);
            methods.push({ name, content });
        }

        const path = 'blah.sol';
        const header = [
            `pragma solidity ^0.5.0;`,
            `import "${this.source.source.path}";`,
            `import "${this.target.source.path}";`,
            `contract Examples is ${this.source.name}, ${this.target.name}`
        ];
        const content = `${header.join(`\n`)} {
    ${methods.map(({ content }) => content).join('\n    ')}
}`;
        const metadata = Compile.fromString({ path, content });
        const names = methods.map(({ name }) => name);
        return { metadata, names };
    }

    methodForExample(example: SimulationExample, name: string): string {
        const { source: { trace: { operations: sOps }},
                target: { trace: { operations: tOps }} } = example;

        const invocations = [
            ...sOps.map(Contract.ofOperation(this.source)),
            ...tOps.map(Contract.ofOperation(this.target))
        ];

        return `function ${name}() public {
        ${invocations.join('\n        ')}
    }`;
    }

    static ofOperation({ name }: Metadata) {
        return function (operation: Operation) {
            const { invocation: { method, inputs } } = operation;
            return `${name}.${method.name}(${inputs.join(', ')});`;
        }
    }
}
