import { Operation,  Value, TypedValue, TypedArrayValue, Values } from "../model";
import { Debugger } from '../utils/debug';
import { VariableDeclaration, FunctionDefinition, fullNameOfElementaryType } from "../solidity";
import { Unit } from "../frontend/unit";

const debug = Debugger(__filename);

export interface ContractInfo {
    name: string;
    path: string;
}

export abstract class Contract {
    auxiliaryDefinitions = new  Map<string,string[]>();

    constructor(public unit: Unit) { }

    async getContract(): Promise<string[]> {
        const imports = await this.getImports();
        const spec = await this.getSpec();
        const parents = await this.getParents();
        const body = await this.getBody();
        const name = this.unit.getName();
        const decl = parents.length > 0
            ? `${name} is ${parents.join(', ')}`
            : `${name}`;

        const aux = [...this.auxiliaryDefinitions.values()].flat();
        const lines = block()(
            `pragma solidity ^0.5.0;`,
            ``,
            ...imports.map(f => `import "${f}";`),
            ``,
            ...spec,
            `contract ${decl} {`,
            ...block(4)(...body, ...aux),
            `}`
        );
        return lines;
    }

    abstract async getImports(): Promise<string[]>;
    abstract async getParents(): Promise<string[]>;
    abstract async getSpec(): Promise<string[]>;
    abstract async getBody(): Promise<string[]>;

    async getContent(): Promise<string> {
        const lines = await this.getContract();
        const content = format()(...lines);
        debug(content);
        return content;
    }

    static signature(method: FunctionDefinition) {
        const { modifiers: _, stateMutability, visibility } = method;
        const attributes: string[] = [];
        const parameters = [...FunctionDefinition.parameters(method)].map(Contract.parameter);
        const returns = [...FunctionDefinition.returns(method)].map(Contract.parameter);

        attributes.push(visibility);

        if (stateMutability !== 'nonpayable')
            attributes.push(stateMutability);

        if (returns.length > 0)
            attributes.push(`returns (${returns.join(', ')})`);

        const name = FunctionDefinition.isConstructor(method)
            ? `constructor`
            : `function check$${method.name}`;

        return `${name}(${parameters.join(', ')}) ${attributes.join(' ')}`;
    }

    static parameter(variable: VariableDeclaration): string {
        const { name, storageLocation, typeDescriptions: { typeString: type } } = variable;
        const elems = [type];

        if (storageLocation === 'memory')
            elems.push(storageLocation);

        if (name !== '')
            elems.push(name);

        return elems.join(' ');
    }

    static isPrimitive(type: string) {
        return type.endsWith('[]');
    }

    methodCall(operation: Operation, target?: string) {
        const { invocation: { method: { name }, inputs, value } } = operation;
        const lhs = target === undefined ? name : `${target}.${name}`;
        const args = `(${inputs.map(i => this.argument(i)).join(', ')})`;
        const extra = value === undefined ? '' : `.value(${value})`;
        return `${lhs}${extra}${args};`;
    }

    lowLevelCall(operation: Operation, target: string = 'this') {
        const { invocation: { method: { name }, inputs, value } } = operation;
        const types = inputs.map(v => Value.isElementaryValue(v) ? fullNameOfElementaryType(v.type) : '');
        const sig = `"${name}(${types.join(',')})"`;
        const args = [ sig, ...inputs.map(i => this.argument(i)) ];
        const extra = value === undefined ? '' : `.value(${value})`;
        // TODO what about the value?
        return `address(${target}).call${extra}(abi.encodeWithSignature(${args.join(', ')}));`;
    }

    constructorCall(operation: Operation, target: string) {
        const { invocation: { inputs, value } } = operation;
        const lhs = `(new ${target})`;
        const args = `(${inputs.map(i => this.argument(i)).join(', ')})`;
        const extra = value === undefined ? '' : `.value(${value})`;
        return `${lhs}${extra}${args};`;
    }

    callMethod(contractName: string, method: FunctionDefinition, returnVarPrefix: string) {
        const args = [...FunctionDefinition.parameters(method)].map(({ name }) => name).join(', ');
        const returns = [...FunctionDefinition.returns(method)].map((_, i) => `${returnVarPrefix}_ret_${i}`);
        const assignments = returns.length > 0 ? `${returns.join(', ')} = ` : ``;

        const name = FunctionDefinition.isConstructor(method)
            ? contractName
            : `${contractName}.${method.name}`;

        return `${assignments}${name}(${args})`
    }

    argument(typedValue: TypedValue): string {
        if (Value.isElementaryValue(typedValue))
            return Value.toString(typedValue);

        if (typedValue.length !== undefined)
            throw Error(`TODO encode static arrays`);

        const { values } = typedValue;
        const [value] = values;

        if (!Value.isElementaryValue(value))
            throw Error(`TODO encode nested arrays`);

        const { type: baseType } = value;
        const argType = baseType === 'address' ? 'uint160' : baseType;

        const fn = this.encodedArrayName(typedValue);

        if (!this.auxiliaryDefinitions.has(fn))
            this.auxiliaryDefinitions.set(fn, this.arrayEncodingFunction(typedValue));

        return `${fn}([${values.map(v => `${argType}(${this.argument(v)})`)}])`;
    }

    encodedArrayName(ary: TypedArrayValue): string {
        const { values } = ary;
        const [value] = values;
        const { length } = values;

        if (!Value.isElementaryValue(value))
            throw Error(`TODO encode nested arrays`);

        const { type: baseType } = value;
        return `${baseType}$ary$${length}`;
    }

    arrayEncodingFunction(ary: TypedArrayValue): string[] {
        const { values } = ary;
        const [value] = values;
        const { length } = values;

        if (!Value.isElementaryValue(value))
            throw Error(`TODO encode nested arrays`);

        const { type: baseType } = value;
        const argType = baseType === 'address' ? 'uint160' : baseType;

        return [
            ``,
            `function ${this.encodedArrayName(ary)}(${argType}[${length}] memory ary) internal pure returns (${baseType}[] memory) {`,
            ...block(4)(
                `${baseType}[] memory ret = new ${baseType}[](${length});`,
                `for (uint i = 0; i < ${length}; i++)`,
                ...block(4)(
                    `ret[i] = ${baseType}(ary[i]);`
                ),
                `return ret;`
            ),
            `}`
        ];
    }
}

export function block(indent?: number) {
    return function(...lines: string[]): string[] {
        return lines.map(line => line === '' ? '' : `${' '.repeat(indent || 0)}${line}`);
    }
}

export function format(indent?: number) {
    return function(...lines: string[]): string {
        return lines.map(line => line === '' ? '' : `${' '.repeat(indent || 0)}${line}`).join('\n');
    }
}
