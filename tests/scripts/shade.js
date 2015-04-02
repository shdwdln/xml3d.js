!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Shade=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
module.exports = require('./lib');

},{"./lib":5}],2:[function(require,module,exports){

var walkes = require('walkes');
var worklist = require('../');
var Set = require('../set');

module.exports = availableExpressions;

/*
So here is the story:
Each node is supposed to have a `Set` of expressions. And for each expression,
I want to save the `Set` of contained variables for easier killing.

Since JS has no records yet (see http://wiki.ecmascript.org/doku.php?id=strawman:records )
and no concept of structural equality, an expression represented by an AST node
is *never ever* equal to an structurally equal expression unless its the
identical node.
The same goes for `Set`s. Since they are just shimmed using normal Objects, they
are *never ever* equal, although they contain the exact same members.

So as a workaround, I `JSON.stringify` the expression to save it in the Set and
use a mapping table to get to the expression object and the corresponding set of
variables.

Of course, I could just use a custom Set implementation which uses a custom
equality check function. But I want to be forward-compatible with the upcoming
ES6 standard, which should provide a O(1) Sets, instead of the O(n) shim.
*/

function availableExpressions(cfg) {
	var expressionMap = {};

	function findExpressions(ast) {
		var expressions = new Set();
		// FIXME: just handling binary expressions so far
		walkes(ast, {
			Identifier: function () {
				return new Set(this.name);
			},
			Literal: function () {
				return new Set();
			},
			BinaryExpression: function (recurse) {
				var stringified = JSON.stringify(this);
				expressions.add(stringified);
				if (stringified in expressionMap) {
					return expressionMap[stringified].variables;
				}
				var right = recurse(this.right);
				var left = recurse(this.left);
				var variables = Set.union(left, right);
				expressionMap[stringified] = {
					expression: this,
					variables: variables
				};
				return variables;
			}
		});
		return expressions;
	}

	// run the algorithm
	var output = worklist(cfg, function (input, list) {
		if (this.type || !this.astNode)
			return input;
		var kill = this.kill = this.kill || findAssignments(this.astNode);
		var generate = this.generate = this.generate || findExpressions(this.astNode);
		var killed = new Set(input.values().filter(function (expr) {
			var variables = expressionMap[expr].variables;
			return !Set.intersect(variables, kill).size;
		}));
		return Set.union(killed, generate);
	}, {direction: 'forward', merge: worklist.merge(Set.intersect)});

	// go over all the nodes and push down the real objects into the output
	cfg[2].forEach(function (node) {
		var out = output.get(node);
		output.set(node, new Set(out.values().map(function (expr) {
			return expressionMap[expr].expression;
		})));
	});

	return output;
}

function findAssignments(ast) {
	var variables = new Set();
	walkes(ast, {
		AssignmentExpression: function (recurse) {
			if (this.left.type === 'Identifier')
				variables.add(this.left.name);
			recurse(this.right);
		},
		VariableDeclarator: function (recurse) {
			variables.add(this.id.name);
			if (this.init)
				recurse(this.init);
		}
	});
	return variables;
}


},{"../":5,"../set":7,"walkes":49}],3:[function(require,module,exports){

exports.liveVariables = require('./livevariables');
exports.availableExpressions = require('./availableexpressions');


},{"./availableexpressions":2,"./livevariables":4}],4:[function(require,module,exports){

var walkes = require('walkes');
var worklist = require('../');
var Set = require('../set');

module.exports = liveVariables;

function liveVariables(cfg) {
	return worklist(cfg, function (input) {
		if (this.type || !this.astNode)
			return input;
		var kill = this.kill = this.kill || findAssignments(this.astNode);
		var generate = this.generate = this.generate || findVariables(this.astNode);
		return Set.union(Set.minus(input, kill), generate);
	}, {direction: 'backward'});
}

function findAssignments(astNode) {
	var variables = new Set();
	walkes(astNode, {
		AssignmentExpression: function (recurse) {
			if (this.left.type === 'Identifier')
				variables.add(this.left.name);
			recurse(this.right);
		},
		FunctionDeclaration: function () {},
		FunctionExpression: function () {},
		VariableDeclarator: function (recurse) {
			variables.add(this.id.name);
			if (this.init)
				recurse(this.init);
		}
	});
	return variables;
}
function findVariables(astNode) {
	var variables = new Set();
	walkes(astNode, {
		AssignmentExpression: function (recurse) {
			if (this.left.type !== 'Identifier')
				recurse(this.left);
			recurse(this.right);
		},
		FunctionDeclaration: function () {},
		FunctionExpression: function () {},
		Identifier: function () {
			variables.add(this.name);
		},
		MemberExpression: function (recurse) {
			recurse(this.object);
		},
		Property: function (recurse) {
			recurse(this.value);
		},
		VariableDeclarator: function (recurse) {
			recurse(this.init);
		}
	});
	return variables;
}


},{"../":5,"../set":7,"walkes":49}],5:[function(require,module,exports){

var Queue = require('./queue');
var Set = require('./set');

var exports = module.exports = worklist;

// expose the utilities to have them tested separately
exports.Queue = Queue;
exports.Set = Set;
exports.examples = require('./examples');

/**
 * Implementation of a general worklist algorithm
 * `cfg` is a control flow graph created by `esgraph`,
 * `transferFunction` gets called with (this = node, input, worklist)
 * it operates on the input `Set` and can return an output set, in which case
 * the worklist algorithm automatically enqueues all the successor nodes, or it
 * might return an {output: output, enqueue: false} object in which case it is
 * itself responsible to enqueue the successor nodes.
 * `options` defines the `direction`, a `merge` function and an `equals`
 * function which merge the inputs to a node and determine if a node has changed
 * its output respectively.
 * Returns a `Map` from node -> output
 */
function worklist(cfg, transferFunction, options) {
	options = options || {};
	var direction = options.direction || 'forward';
	var merge = options.merge || worklist.merge(Set.union);
	var equals = options.equals || Set.equals;
	var list = new Queue();
	if (direction === 'forward') {
		list.push(cfg[0]);
		var predecessors = worklist.predecessors;
		var successors = worklist.successors;
	} else {
		list.push(cfg[1]);
		var predecessors = worklist.successors;
		var successors = worklist.predecessors;
	}
	var start = options.start || new Set();

	var output = new Map();
	while (list.length) {
		var node = list.shift();
		var pre = predecessors(node)
			.map(function (n) { return output.get(n); });
		var input = pre.length ? merge(pre) : start;
		var oldOutput = output.get(node);
		var out = transferFunction.call(node, input, list, oldOutput);
		if (!out || out instanceof Set)
			out = {output: out, enqueue: true};
		output.set(node, out.output);
		if (out.enqueue && (!oldOutput || !equals(out.output, oldOutput)))
			successors(node).forEach(list.push.bind(list));
	}
	return output;
};

worklist.predecessors = function (node) {
	return node.prev;
};
worklist.successors = function (node) {
	return node.next;
};

worklist.merge = function (fn) {
	return function (inputs) {
		if (inputs.length == 1)
			return new Set(inputs[0]);
		return inputs.reduce(fn);
	};
};


},{"./examples":3,"./queue":6,"./set":7}],6:[function(require,module,exports){

module.exports = Queue;

/**
 * This is a really small priority queue that makes sure that duplicate elements
 * are being inserted at the end
 */
function Queue() {
	var q = [];
	q.__proto__ = Queue.prototype;
	return q;
}

Queue.prototype = Object.create(Array.prototype);
Queue.prototype.push = function Queue_push(elem) {
	var pos = this.indexOf(elem);
	if (pos != -1)
		this.splice(pos, 1);
	Array.prototype.push.call(this, elem);
};

},{}],7:[function(require,module,exports){

module.exports = Set;

/**
 * ES6 Sets in `node --harmony` do not provide `.values()` or `for of` iteration
 * yet, so they are pretty useless :-(
 * This Set also does not use `Object.is`; we do not care about NaN, -0, +0
 */
function Set(elements) {
	this._values = [];
	if (Array.isArray(elements))
		elements.forEach(this.add.bind(this));
	else if (elements instanceof Set)
		elements._values.forEach(this.add.bind(this));
}
Object.defineProperty(Set.prototype, 'size', {
	enumerable: false,
	configurable: false,
	get: function () {
		return this._values.length;
	}
});
Set.prototype._i = function Set__i(elem) {
	return this._values.indexOf(elem);
};
Set.prototype.add = function Set_add(elem) {
	if (!this.has(elem))
		this._values.push(elem);
};
Set.prototype.has = function Set_has(elem) {
	return !!~this._i(elem);
};
Set.prototype.delete = function Set_delete(elem) {
	var i = this._i(elem);
	if (!~i)
		return;
	this._values.splice(i, 1);
};
Set.prototype.values = function Set_values() {
	return [].concat(this._values);
};

// forward some convenience functions from Array.prototype
[
	'some',
	'map',
	'every',
	'filter',
	'forEach'
].forEach(function (method) {
	Set.prototype[method] = function () {
		return Array.prototype[method].apply(this._values, arguments);
	}
});

// some convenience functions
Set.prototype.first = function Set_first() {
	return this._values[0];
};
Set.intersect = function intersect(a, b) {
	if (!a && b)
		return new Set(b);
	if (!b && a)
		return new Set(a);
	var s = new Set();
	a.forEach(function (val) {
		if (b.has(val))
			s.add(val);
	});
	return s;
};
Set.union = function union(a, b) {
	if (!a && b)
		return new Set(b);
	var s = new Set(a);
	if (b)
		b.forEach(s.add.bind(s));
	return s;
};
Set.equals = function equals(a, b) {
	if (a.size != b.size)
		return false;
	return a.every(function (val) {
		return b.has(val);
	});
};
Set.minus = function minus(a, b) {
	var s = new Set(a);
	b.forEach(s.delete.bind(s));
	return s;
};


},{}],8:[function(require,module,exports){
(function (global){
//! Copyright 2012 Eric Wendelin - MIT License

/**
 * es6-map-shim.js is a DESTRUCTIVE shim that follows the latest Map specification as closely as possible.
 * It is destructive in the sense that it overrides native implementations.
 *
 * This library assumes ES5 functionality: Object.create, Object.defineProperty, Array.indexOf, Function.bind
 */
(function(module) {
    function Map(iterable) {
        var _items = [];
        var _keys = [];
        var _values = [];

        // Object.is polyfill, courtesy of @WebReflection
        var is = Object.is || function(a, b) {
            return a === b ?
                a !== 0 || 1 / a == 1 / b :
                a != a && b != b;
        };

        // More reliable indexOf, courtesy of @WebReflection
        var betterIndexOf = function(value) {
            if(value != value || value === 0) {
                for(var i = this.length; i-- && !is(this[i], value););
            } else {
                i = [].indexOf.call(this, value);
            }
            return i;
        };

        var MapIterator = function MapIterator(map, kind) {
            var _index = 0;

            return Object.create({}, {
                next: {
                    value: function() {
                        // check if index is within bounds
                        if (_index < map.items().length) {
                            switch(kind) {
                                case 'keys': return map.keys()[_index++];
                                case 'values': return map.values()[_index++];
                                case 'keys+values': return [].slice.call(map.items()[_index++]);
                                default: throw new TypeError('Invalid iterator type');
                            }
                        }
                        // TODO: make sure I'm interpreting the spec correctly here
                        throw new Error('Stop Iteration');
                    }
                },
                iterator: {
                    value: function() {
                        return this;
                    }
                },
                toString: {
                    value: function() {
                        return '[object Map Iterator]';
                    }
                }
            });
        };

        var _set = function(key, value) {
            // check if key exists and overwrite
            var index = betterIndexOf.call(_keys, key);
            if (index > -1) {
                _items[index] = value;
                _values[index] = value;
            } else {
                _items.push([key, value]);
                _keys.push(key);
                _values.push(value);
            }
        };

        var setItem = function(item) {
            if (item.length !== 2) {
                throw new TypeError('Invalid iterable passed to Map constructor');
            }

            _set(item[0], item[1]);
        };

        // FIXME: accommodate any class that defines an @@iterator method that returns
        //      an iterator object that produces two element array-like objects
        if (Array.isArray(iterable)) {
            iterable.forEach(setItem);
        } else if (iterable !== undefined) {
            throw new TypeError('Invalid Map');
        }

        return Object.create(MapPrototype, {
            items:{
                value:function() {
                    return [].slice.call(_items);
                }
            },
            keys:{
                value:function() {
                    return [].slice.call(_keys);
                }
            },
            values:{
                value:function() {
                    return [].slice.call(_values);
                }
            },
            has:{
                value:function(key) {
                    // TODO: check how spec reads about null values
                    var index = betterIndexOf.call(_keys, key);
                    return index > -1;
                }
            },
            get:{
                value:function(key) {
                    var index = betterIndexOf.call(_keys, key);
                    return index > -1 ? _values[index] : undefined;
                }
            },
            set:{
                value: _set
            },
            size:{
                get:function() {
                    return _items.length;
                }
            },
            clear:{
                value:function() {
                    _keys.length = _values.length = _items.length = 0;
                }
            },
            'delete':{
                value:function(key) {
                    var index = betterIndexOf.call(_keys, key);
                    if (index > -1) {
                        _keys.splice(index, 1);
                        _values.splice(index, 1);
                        _items.splice(index, 1);
                        return true;
                    }
                    return false;
                }
            },
            forEach:{
                value:function(callbackfn /*, thisArg*/) {
                    if (typeof callbackfn != 'function') {
                        throw new TypeError('Invalid callback function given to forEach');
                    }

                    function tryNext() {
                        try {
                            return iter.next();
                        } catch(e) {
                            return undefined;
                        }
                    }

                    var iter = this.iterator();
                    var current = tryNext();
                    var next = tryNext();
                    while(current !== undefined) {
                        callbackfn.apply(arguments[1], [current[1], current[0], this]);
                        current = next;
                        next = tryNext();
                    }
                }
            },
            iterator:{
                value: function() {
                    return new MapIterator(this, 'keys+values');
                }
            },
            toString:{
                value: function() {
                    return '[Object Map]';
                }
            }
        });
    }

    var notInNode = module == 'undefined';
    var window = notInNode ? this : global;
    var module = notInNode ? {} : exports;
    var MapPrototype = Map.prototype;

    Map.prototype = MapPrototype = Map();

    window.Map = module.Map = window.Map || Map;
}.call(this, typeof exports));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],9:[function(require,module,exports){
(function (global){
/*
  Copyright (C) 2012-2014 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012-2013 Michael Ficarra <escodegen.copyright@michael.ficarra.me>
  Copyright (C) 2012-2013 Mathias Bynens <mathias@qiwi.be>
  Copyright (C) 2013 Irakli Gozalishvili <rfobic@gmail.com>
  Copyright (C) 2012 Robert Gust-Bardon <donate@robert.gust-bardon.org>
  Copyright (C) 2012 John Freeman <jfreeman08@gmail.com>
  Copyright (C) 2011-2012 Ariya Hidayat <ariya.hidayat@gmail.com>
  Copyright (C) 2012 Joost-Wim Boekesteijn <joost-wim@boekesteijn.nl>
  Copyright (C) 2012 Kris Kowal <kris.kowal@cixar.com>
  Copyright (C) 2012 Arpad Borsos <arpad.borsos@googlemail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*global exports:true, require:true, global:true*/
(function () {
    'use strict';

    var Syntax,
        Precedence,
        BinaryPrecedence,
        SourceNode,
        estraverse,
        esutils,
        isArray,
        base,
        indent,
        json,
        renumber,
        hexadecimal,
        quotes,
        escapeless,
        newline,
        space,
        parentheses,
        semicolons,
        safeConcatenation,
        directive,
        extra,
        parse,
        sourceMap,
        FORMAT_MINIFY,
        FORMAT_DEFAULTS;

    estraverse = require('estraverse');
    esutils = require('esutils');

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        ArrayExpression: 'ArrayExpression',
        ArrayPattern: 'ArrayPattern',
        ArrowFunctionExpression: 'ArrowFunctionExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ClassBody: 'ClassBody',
        ClassDeclaration: 'ClassDeclaration',
        ClassExpression: 'ClassExpression',
        ComprehensionBlock: 'ComprehensionBlock',
        ComprehensionExpression: 'ComprehensionExpression',
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DirectiveStatement: 'DirectiveStatement',
        DoWhileStatement: 'DoWhileStatement',
        DebuggerStatement: 'DebuggerStatement',
        EmptyStatement: 'EmptyStatement',
        ExportBatchSpecifier: 'ExportBatchSpecifier',
        ExportDeclaration: 'ExportDeclaration',
        ExportSpecifier: 'ExportSpecifier',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForInStatement: 'ForInStatement',
        ForOfStatement: 'ForOfStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        GeneratorExpression: 'GeneratorExpression',
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        ImportSpecifier: 'ImportSpecifier',
        ImportDeclaration: 'ImportDeclaration',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        MethodDefinition: 'MethodDefinition',
        ModuleDeclaration: 'ModuleDeclaration',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        ObjectPattern: 'ObjectPattern',
        Program: 'Program',
        Property: 'Property',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SpreadElement: 'SpreadElement',
        SwitchStatement: 'SwitchStatement',
        SwitchCase: 'SwitchCase',
        TaggedTemplateExpression: 'TaggedTemplateExpression',
        TemplateElement: 'TemplateElement',
        TemplateLiteral: 'TemplateLiteral',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement',
        YieldExpression: 'YieldExpression'
    };

    // Generation is done by generateExpression.
    function isExpression(node) {
        switch (node.type) {
        case Syntax.AssignmentExpression:
        case Syntax.ArrayExpression:
        case Syntax.ArrayPattern:
        case Syntax.BinaryExpression:
        case Syntax.CallExpression:
        case Syntax.ConditionalExpression:
        case Syntax.ClassExpression:
        case Syntax.ExportBatchSpecifier:
        case Syntax.ExportSpecifier:
        case Syntax.FunctionExpression:
        case Syntax.Identifier:
        case Syntax.ImportSpecifier:
        case Syntax.Literal:
        case Syntax.LogicalExpression:
        case Syntax.MemberExpression:
        case Syntax.MethodDefinition:
        case Syntax.NewExpression:
        case Syntax.ObjectExpression:
        case Syntax.ObjectPattern:
        case Syntax.Property:
        case Syntax.SequenceExpression:
        case Syntax.ThisExpression:
        case Syntax.UnaryExpression:
        case Syntax.UpdateExpression:
        case Syntax.YieldExpression:
            return true;
        }
        return false;
    }

    // Generation is done by generateStatement.
    function isStatement(node) {
        switch (node.type) {
        case Syntax.BlockStatement:
        case Syntax.BreakStatement:
        case Syntax.CatchClause:
        case Syntax.ContinueStatement:
        case Syntax.ClassDeclaration:
        case Syntax.ClassBody:
        case Syntax.DirectiveStatement:
        case Syntax.DoWhileStatement:
        case Syntax.DebuggerStatement:
        case Syntax.EmptyStatement:
        case Syntax.ExpressionStatement:
        case Syntax.ForStatement:
        case Syntax.ForInStatement:
        case Syntax.ForOfStatement:
        case Syntax.FunctionDeclaration:
        case Syntax.IfStatement:
        case Syntax.LabeledStatement:
        case Syntax.ModuleDeclaration:
        case Syntax.Program:
        case Syntax.ReturnStatement:
        case Syntax.SwitchStatement:
        case Syntax.SwitchCase:
        case Syntax.ThrowStatement:
        case Syntax.TryStatement:
        case Syntax.VariableDeclaration:
        case Syntax.VariableDeclarator:
        case Syntax.WhileStatement:
        case Syntax.WithStatement:
            return true;
        }
        return false;
    }

    Precedence = {
        Sequence: 0,
        Yield: 1,
        Assignment: 1,
        Conditional: 2,
        ArrowFunction: 2,
        LogicalOR: 3,
        LogicalAND: 4,
        BitwiseOR: 5,
        BitwiseXOR: 6,
        BitwiseAND: 7,
        Equality: 8,
        Relational: 9,
        BitwiseSHIFT: 10,
        Additive: 11,
        Multiplicative: 12,
        Unary: 13,
        Postfix: 14,
        Call: 15,
        New: 16,
        TaggedTemplate: 17,
        Member: 18,
        Primary: 19
    };

    BinaryPrecedence = {
        '||': Precedence.LogicalOR,
        '&&': Precedence.LogicalAND,
        '|': Precedence.BitwiseOR,
        '^': Precedence.BitwiseXOR,
        '&': Precedence.BitwiseAND,
        '==': Precedence.Equality,
        '!=': Precedence.Equality,
        '===': Precedence.Equality,
        '!==': Precedence.Equality,
        'is': Precedence.Equality,
        'isnt': Precedence.Equality,
        '<': Precedence.Relational,
        '>': Precedence.Relational,
        '<=': Precedence.Relational,
        '>=': Precedence.Relational,
        'in': Precedence.Relational,
        'instanceof': Precedence.Relational,
        '<<': Precedence.BitwiseSHIFT,
        '>>': Precedence.BitwiseSHIFT,
        '>>>': Precedence.BitwiseSHIFT,
        '+': Precedence.Additive,
        '-': Precedence.Additive,
        '*': Precedence.Multiplicative,
        '%': Precedence.Multiplicative,
        '/': Precedence.Multiplicative
    };

    function getDefaultOptions() {
        // default options
        return {
            indent: null,
            base: null,
            parse: null,
            comment: false,
            format: {
                indent: {
                    style: '    ',
                    base: 0,
                    adjustMultilineComment: false
                },
                newline: '\n',
                space: ' ',
                json: false,
                renumber: false,
                hexadecimal: false,
                quotes: 'single',
                escapeless: false,
                compact: false,
                parentheses: true,
                semicolons: true,
                safeConcatenation: false
            },
            moz: {
                comprehensionExpressionStartsWithAssignment: false,
                starlessGenerator: false
            },
            sourceMap: null,
            sourceMapRoot: null,
            sourceMapWithCode: false,
            directive: false,
            raw: true,
            verbatim: null
        };
    }

    function stringRepeat(str, num) {
        var result = '';

        for (num |= 0; num > 0; num >>>= 1, str += str) {
            if (num & 1) {
                result += str;
            }
        }

        return result;
    }

    isArray = Array.isArray;
    if (!isArray) {
        isArray = function isArray(array) {
            return Object.prototype.toString.call(array) === '[object Array]';
        };
    }

    function hasLineTerminator(str) {
        return (/[\r\n]/g).test(str);
    }

    function endsWithLineTerminator(str) {
        var len = str.length;
        return len && esutils.code.isLineTerminator(str.charCodeAt(len - 1));
    }

    function updateDeeply(target, override) {
        var key, val;

        function isHashObject(target) {
            return typeof target === 'object' && target instanceof Object && !(target instanceof RegExp);
        }

        for (key in override) {
            if (override.hasOwnProperty(key)) {
                val = override[key];
                if (isHashObject(val)) {
                    if (isHashObject(target[key])) {
                        updateDeeply(target[key], val);
                    } else {
                        target[key] = updateDeeply({}, val);
                    }
                } else {
                    target[key] = val;
                }
            }
        }
        return target;
    }

    function generateNumber(value) {
        var result, point, temp, exponent, pos;

        if (value !== value) {
            throw new Error('Numeric literal whose value is NaN');
        }
        if (value < 0 || (value === 0 && 1 / value < 0)) {
            throw new Error('Numeric literal whose value is negative');
        }

        if (value === 1 / 0) {
            return json ? 'null' : renumber ? '1e400' : '1e+400';
        }

        result = '' + value;
        if (!renumber || result.length < 3) {
            return result;
        }

        point = result.indexOf('.');
        if (!json && result.charCodeAt(0) === 0x30  /* 0 */ && point === 1) {
            point = 0;
            result = result.slice(1);
        }
        temp = result;
        result = result.replace('e+', 'e');
        exponent = 0;
        if ((pos = temp.indexOf('e')) > 0) {
            exponent = +temp.slice(pos + 1);
            temp = temp.slice(0, pos);
        }
        if (point >= 0) {
            exponent -= temp.length - point - 1;
            temp = +(temp.slice(0, point) + temp.slice(point + 1)) + '';
        }
        pos = 0;
        while (temp.charCodeAt(temp.length + pos - 1) === 0x30  /* 0 */) {
            --pos;
        }
        if (pos !== 0) {
            exponent -= pos;
            temp = temp.slice(0, pos);
        }
        if (exponent !== 0) {
            temp += 'e' + exponent;
        }
        if ((temp.length < result.length ||
                    (hexadecimal && value > 1e12 && Math.floor(value) === value && (temp = '0x' + value.toString(16)).length < result.length)) &&
                +temp === value) {
            result = temp;
        }

        return result;
    }

    // Generate valid RegExp expression.
    // This function is based on https://github.com/Constellation/iv Engine

    function escapeRegExpCharacter(ch, previousIsBackslash) {
        // not handling '\' and handling \u2028 or \u2029 to unicode escape sequence
        if ((ch & ~1) === 0x2028) {
            return (previousIsBackslash ? 'u' : '\\u') + ((ch === 0x2028) ? '2028' : '2029');
        } else if (ch === 10 || ch === 13) {  // \n, \r
            return (previousIsBackslash ? '' : '\\') + ((ch === 10) ? 'n' : 'r');
        }
        return String.fromCharCode(ch);
    }

    function generateRegExp(reg) {
        var match, result, flags, i, iz, ch, characterInBrack, previousIsBackslash;

        result = reg.toString();

        if (reg.source) {
            // extract flag from toString result
            match = result.match(/\/([^/]*)$/);
            if (!match) {
                return result;
            }

            flags = match[1];
            result = '';

            characterInBrack = false;
            previousIsBackslash = false;
            for (i = 0, iz = reg.source.length; i < iz; ++i) {
                ch = reg.source.charCodeAt(i);

                if (!previousIsBackslash) {
                    if (characterInBrack) {
                        if (ch === 93) {  // ]
                            characterInBrack = false;
                        }
                    } else {
                        if (ch === 47) {  // /
                            result += '\\';
                        } else if (ch === 91) {  // [
                            characterInBrack = true;
                        }
                    }
                    result += escapeRegExpCharacter(ch, previousIsBackslash);
                    previousIsBackslash = ch === 92;  // \
                } else {
                    // if new RegExp("\\\n') is provided, create /\n/
                    result += escapeRegExpCharacter(ch, previousIsBackslash);
                    // prevent like /\\[/]/
                    previousIsBackslash = false;
                }
            }

            return '/' + result + '/' + flags;
        }

        return result;
    }

    function escapeAllowedCharacter(code, next) {
        var hex, result = '\\';

        switch (code) {
        case 0x08  /* \b */:
            result += 'b';
            break;
        case 0x0C  /* \f */:
            result += 'f';
            break;
        case 0x09  /* \t */:
            result += 't';
            break;
        default:
            hex = code.toString(16).toUpperCase();
            if (json || code > 0xFF) {
                result += 'u' + '0000'.slice(hex.length) + hex;
            } else if (code === 0x0000 && !esutils.code.isDecimalDigit(next)) {
                result += '0';
            } else if (code === 0x000B  /* \v */) { // '\v'
                result += 'x0B';
            } else {
                result += 'x' + '00'.slice(hex.length) + hex;
            }
            break;
        }

        return result;
    }

    function escapeDisallowedCharacter(code) {
        var result = '\\';
        switch (code) {
        case 0x5C  /* \ */:
            result += '\\';
            break;
        case 0x0A  /* \n */:
            result += 'n';
            break;
        case 0x0D  /* \r */:
            result += 'r';
            break;
        case 0x2028:
            result += 'u2028';
            break;
        case 0x2029:
            result += 'u2029';
            break;
        default:
            throw new Error('Incorrectly classified character');
        }

        return result;
    }

    function escapeDirective(str) {
        var i, iz, code, quote;

        quote = quotes === 'double' ? '"' : '\'';
        for (i = 0, iz = str.length; i < iz; ++i) {
            code = str.charCodeAt(i);
            if (code === 0x27  /* ' */) {
                quote = '"';
                break;
            } else if (code === 0x22  /* " */) {
                quote = '\'';
                break;
            } else if (code === 0x5C  /* \ */) {
                ++i;
            }
        }

        return quote + str + quote;
    }

    function escapeString(str) {
        var result = '', i, len, code, singleQuotes = 0, doubleQuotes = 0, single, quote;

        for (i = 0, len = str.length; i < len; ++i) {
            code = str.charCodeAt(i);
            if (code === 0x27  /* ' */) {
                ++singleQuotes;
            } else if (code === 0x22  /* " */) {
                ++doubleQuotes;
            } else if (code === 0x2F  /* / */ && json) {
                result += '\\';
            } else if (esutils.code.isLineTerminator(code) || code === 0x5C  /* \ */) {
                result += escapeDisallowedCharacter(code);
                continue;
            } else if ((json && code < 0x20  /* SP */) || !(json || escapeless || (code >= 0x20  /* SP */ && code <= 0x7E  /* ~ */))) {
                result += escapeAllowedCharacter(code, str.charCodeAt(i + 1));
                continue;
            }
            result += String.fromCharCode(code);
        }

        single = !(quotes === 'double' || (quotes === 'auto' && doubleQuotes < singleQuotes));
        quote = single ? '\'' : '"';

        if (!(single ? singleQuotes : doubleQuotes)) {
            return quote + result + quote;
        }

        str = result;
        result = quote;

        for (i = 0, len = str.length; i < len; ++i) {
            code = str.charCodeAt(i);
            if ((code === 0x27  /* ' */ && single) || (code === 0x22  /* " */ && !single)) {
                result += '\\';
            }
            result += String.fromCharCode(code);
        }

        return result + quote;
    }

    /**
     * flatten an array to a string, where the array can contain
     * either strings or nested arrays
     */
    function flattenToString(arr) {
        var i, iz, elem, result = '';
        for (i = 0, iz = arr.length; i < iz; ++i) {
            elem = arr[i];
            result += isArray(elem) ? flattenToString(elem) : elem;
        }
        return result;
    }

    /**
     * convert generated to a SourceNode when source maps are enabled.
     */
    function toSourceNodeWhenNeeded(generated, node) {
        if (!sourceMap) {
            // with no source maps, generated is either an
            // array or a string.  if an array, flatten it.
            // if a string, just return it
            if (isArray(generated)) {
                return flattenToString(generated);
            } else {
                return generated;
            }
        }
        if (node == null) {
            if (generated instanceof SourceNode) {
                return generated;
            } else {
                node = {};
            }
        }
        if (node.loc == null) {
            return new SourceNode(null, null, sourceMap, generated, node.name || null);
        }
        return new SourceNode(node.loc.start.line, node.loc.start.column, (sourceMap === true ? node.loc.source || null : sourceMap), generated, node.name || null);
    }

    function noEmptySpace() {
        return (space) ? space : ' ';
    }

    function join(left, right) {
        var leftSource,
            rightSource,
            leftCharCode,
            rightCharCode;

        leftSource = toSourceNodeWhenNeeded(left).toString();
        if (leftSource.length === 0) {
            return [right];
        }

        rightSource = toSourceNodeWhenNeeded(right).toString();
        if (rightSource.length === 0) {
            return [left];
        }

        leftCharCode = leftSource.charCodeAt(leftSource.length - 1);
        rightCharCode = rightSource.charCodeAt(0);

        if ((leftCharCode === 0x2B  /* + */ || leftCharCode === 0x2D  /* - */) && leftCharCode === rightCharCode ||
            esutils.code.isIdentifierPart(leftCharCode) && esutils.code.isIdentifierPart(rightCharCode) ||
            leftCharCode === 0x2F  /* / */ && rightCharCode === 0x69  /* i */) { // infix word operators all start with `i`
            return [left, noEmptySpace(), right];
        } else if (esutils.code.isWhiteSpace(leftCharCode) || esutils.code.isLineTerminator(leftCharCode) ||
                esutils.code.isWhiteSpace(rightCharCode) || esutils.code.isLineTerminator(rightCharCode)) {
            return [left, right];
        }
        return [left, space, right];
    }

    function addIndent(stmt) {
        return [base, stmt];
    }

    function withIndent(fn) {
        var previousBase, result;
        previousBase = base;
        base += indent;
        result = fn.call(this, base);
        base = previousBase;
        return result;
    }

    function calculateSpaces(str) {
        var i;
        for (i = str.length - 1; i >= 0; --i) {
            if (esutils.code.isLineTerminator(str.charCodeAt(i))) {
                break;
            }
        }
        return (str.length - 1) - i;
    }

    function adjustMultilineComment(value, specialBase) {
        var array, i, len, line, j, spaces, previousBase, sn;

        array = value.split(/\r\n|[\r\n]/);
        spaces = Number.MAX_VALUE;

        // first line doesn't have indentation
        for (i = 1, len = array.length; i < len; ++i) {
            line = array[i];
            j = 0;
            while (j < line.length && esutils.code.isWhiteSpace(line.charCodeAt(j))) {
                ++j;
            }
            if (spaces > j) {
                spaces = j;
            }
        }

        if (typeof specialBase !== 'undefined') {
            // pattern like
            // {
            //   var t = 20;  /*
            //                 * this is comment
            //                 */
            // }
            previousBase = base;
            if (array[1][spaces] === '*') {
                specialBase += ' ';
            }
            base = specialBase;
        } else {
            if (spaces & 1) {
                // /*
                //  *
                //  */
                // If spaces are odd number, above pattern is considered.
                // We waste 1 space.
                --spaces;
            }
            previousBase = base;
        }

        for (i = 1, len = array.length; i < len; ++i) {
            sn = toSourceNodeWhenNeeded(addIndent(array[i].slice(spaces)));
            array[i] = sourceMap ? sn.join('') : sn;
        }

        base = previousBase;

        return array.join('\n');
    }

    function generateComment(comment, specialBase) {
        if (comment.type === 'Line') {
            if (endsWithLineTerminator(comment.value)) {
                return '//' + comment.value;
            } else {
                // Always use LineTerminator
                return '//' + comment.value + '\n';
            }
        }
        if (extra.format.indent.adjustMultilineComment && /[\n\r]/.test(comment.value)) {
            return adjustMultilineComment('/*' + comment.value + '*/', specialBase);
        }
        return '/*' + comment.value + '*/';
    }

    function addComments(stmt, result) {
        var i, len, comment, save, tailingToStatement, specialBase, fragment;

        if (stmt.leadingComments && stmt.leadingComments.length > 0) {
            save = result;

            comment = stmt.leadingComments[0];
            result = [];
            if (safeConcatenation && stmt.type === Syntax.Program && stmt.body.length === 0) {
                result.push('\n');
            }
            result.push(generateComment(comment));
            if (!endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                result.push('\n');
            }

            for (i = 1, len = stmt.leadingComments.length; i < len; ++i) {
                comment = stmt.leadingComments[i];
                fragment = [generateComment(comment)];
                if (!endsWithLineTerminator(toSourceNodeWhenNeeded(fragment).toString())) {
                    fragment.push('\n');
                }
                result.push(addIndent(fragment));
            }

            result.push(addIndent(save));
        }

        if (stmt.trailingComments) {
            tailingToStatement = !endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString());
            specialBase = stringRepeat(' ', calculateSpaces(toSourceNodeWhenNeeded([base, result, indent]).toString()));
            for (i = 0, len = stmt.trailingComments.length; i < len; ++i) {
                comment = stmt.trailingComments[i];
                if (tailingToStatement) {
                    // We assume target like following script
                    //
                    // var t = 20;  /**
                    //               * This is comment of t
                    //               */
                    if (i === 0) {
                        // first case
                        result = [result, indent];
                    } else {
                        result = [result, specialBase];
                    }
                    result.push(generateComment(comment, specialBase));
                } else {
                    result = [result, addIndent(generateComment(comment))];
                }
                if (i !== len - 1 && !endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                    result = [result, '\n'];
                }
            }
        }

        return result;
    }

    function parenthesize(text, current, should) {
        if (current < should) {
            return ['(', text, ')'];
        }
        return text;
    }

    function maybeBlock(stmt, semicolonOptional, functionBody) {
        var result, noLeadingComment;

        noLeadingComment = !extra.comment || !stmt.leadingComments;

        if (stmt.type === Syntax.BlockStatement && noLeadingComment) {
            return [space, generateStatement(stmt, { functionBody: functionBody })];
        }

        if (stmt.type === Syntax.EmptyStatement && noLeadingComment) {
            return ';';
        }

        withIndent(function () {
            result = [newline, addIndent(generateStatement(stmt, { semicolonOptional: semicolonOptional, functionBody: functionBody }))];
        });

        return result;
    }

    function maybeBlockSuffix(stmt, result) {
        var ends = endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString());
        if (stmt.type === Syntax.BlockStatement && (!extra.comment || !stmt.leadingComments) && !ends) {
            return [result, space];
        }
        if (ends) {
            return [result, base];
        }
        return [result, newline, base];
    }

    function generateVerbatimString(string) {
        var i, iz, result;
        result = string.split(/\r\n|\n/);
        for (i = 1, iz = result.length; i < iz; i++) {
            result[i] = newline + base + result[i];
        }
        return result;
    }

    function generateVerbatim(expr, option) {
        var verbatim, result, prec;
        verbatim = expr[extra.verbatim];

        if (typeof verbatim === 'string') {
            result = parenthesize(generateVerbatimString(verbatim), Precedence.Sequence, option.precedence);
        } else {
            // verbatim is object
            result = generateVerbatimString(verbatim.content);
            prec = (verbatim.precedence != null) ? verbatim.precedence : Precedence.Sequence;
            result = parenthesize(result, prec, option.precedence);
        }

        return toSourceNodeWhenNeeded(result, expr);
    }

    function generateIdentifier(node) {
        return toSourceNodeWhenNeeded(node.name, node);
    }

    function generatePattern(node, options) {
        var result;

        if (node.type === Syntax.Identifier) {
            result = generateIdentifier(node);
        } else {
            result = generateExpression(node, {
                precedence: options.precedence,
                allowIn: options.allowIn,
                allowCall: true
            });
        }

        return result;
    }

    function generateFunctionParams(node) {
        var i, iz, result, hasDefault;

        hasDefault = false;

        if (node.type === Syntax.ArrowFunctionExpression &&
                !node.rest && (!node.defaults || node.defaults.length === 0) &&
                node.params.length === 1 && node.params[0].type === Syntax.Identifier) {
            // arg => { } case
            result = [generateIdentifier(node.params[0])];
        } else {
            result = ['('];
            if (node.defaults) {
                hasDefault = true;
            }
            for (i = 0, iz = node.params.length; i < iz; ++i) {
                if (hasDefault && node.defaults[i]) {
                    // Handle default values.
                    result.push(generateAssignment(node.params[i], node.defaults[i], '=', {
                        precedence: Precedence.Assignment,
                        allowIn: true,
                        allowCall: true
                    }));
                } else {
                    result.push(generatePattern(node.params[i], {
                        precedence: Precedence.Assignment,
                        allowIn: true,
                        allowCall: true
                    }));
                }
                if (i + 1 < iz) {
                    result.push(',' + space);
                }
            }

            if (node.rest) {
                if (node.params.length) {
                    result.push(',' + space);
                }
                result.push('...');
                result.push(generateIdentifier(node.rest, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                }));
            }

            result.push(')');
        }

        return result;
    }

    function generateFunctionBody(node) {
        var result, expr;

        result = generateFunctionParams(node);

        if (node.type === Syntax.ArrowFunctionExpression) {
            result.push(space);
            result.push('=>');
        }

        if (node.expression) {
            result.push(space);
            expr = generateExpression(node.body, {
                precedence: Precedence.Assignment,
                allowIn: true,
                allowCall: true
            });
            if (expr.toString().charAt(0) === '{') {
                expr = ['(', expr, ')'];
            }
            result.push(expr);
        } else {
            result.push(maybeBlock(node.body, false, true));
        }

        return result;
    }

    function generateIterationForStatement(operator, stmt, semicolonIsNotNeeded) {
        var result = ['for' + space + '('];
        withIndent(function () {
            if (stmt.left.type === Syntax.VariableDeclaration) {
                withIndent(function () {
                    result.push(stmt.left.kind + noEmptySpace());
                    result.push(generateStatement(stmt.left.declarations[0], {
                        allowIn: false
                    }));
                });
            } else {
                result.push(generateExpression(stmt.left, {
                    precedence: Precedence.Call,
                    allowIn: true,
                    allowCall: true
                }));
            }

            result = join(result, operator);
            result = [join(
                result,
                generateExpression(stmt.right, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                })
            ), ')'];
        });
        result.push(maybeBlock(stmt.body, semicolonIsNotNeeded));
        return result;
    }

    function generateVariableDeclaration(stmt, semicolon, allowIn) {
        var result, i, iz, node;

        result = [ stmt.kind ];

        function block() {
            node = stmt.declarations[0];
            if (extra.comment && node.leadingComments) {
                result.push('\n');
                result.push(addIndent(generateStatement(node, {
                    allowIn: allowIn
                })));
            } else {
                result.push(noEmptySpace());
                result.push(generateStatement(node, {
                    allowIn: allowIn
                }));
            }

            for (i = 1, iz = stmt.declarations.length; i < iz; ++i) {
                node = stmt.declarations[i];
                if (extra.comment && node.leadingComments) {
                    result.push(',' + newline);
                    result.push(addIndent(generateStatement(node, {
                        allowIn: allowIn
                    })));
                } else {
                    result.push(',' + space);
                    result.push(generateStatement(node, {
                        allowIn: allowIn
                    }));
                }
            }
        }

        if (stmt.declarations.length > 1) {
            withIndent(block);
        } else {
            block();
        }

        result.push(semicolon);

        return result;
    }

    function generateClassBody(classBody) {
        var result = [ '{', newline];

        withIndent(function (indent) {
            var i, iz;

            for (i = 0, iz = classBody.body.length; i < iz; ++i) {
                result.push(indent);
                result.push(generateExpression(classBody.body[i], {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true,
                    type: Syntax.Property
                }));
                if (i + 1 < iz) {
                    result.push(newline);
                }
            }
        });

        if (!endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
            result.push(newline);
        }
        result.push(base);
        result.push('}');
        return result;
    }

    function generateLiteral(expr) {
        var raw;
        if (expr.hasOwnProperty('raw') && parse && extra.raw) {
            try {
                raw = parse(expr.raw).body[0].expression;
                if (raw.type === Syntax.Literal) {
                    if (raw.value === expr.value) {
                        return expr.raw;
                    }
                }
            } catch (e) {
                // not use raw property
            }
        }

        if (expr.value === null) {
            return 'null';
        }

        if (typeof expr.value === 'string') {
            return escapeString(expr.value);
        }

        if (typeof expr.value === 'number') {
            return generateNumber(expr.value);
        }

        if (typeof expr.value === 'boolean') {
            return expr.value ? 'true' : 'false';
        }

        return generateRegExp(expr.value);
    }

    function generatePropertyKey(expr, computed, option) {
        var result = [];

        if (computed) {
            result.push('[');
        }
        result.push(generateExpression(expr, option));
        if (computed) {
            result.push(']');
        }

        return result;
    }

    function generateAssignment(left, right, operator, option) {
        var allowIn, precedence;

        precedence = option.precedence;
        allowIn = option.allowIn || (Precedence.Assignment < precedence);

        return parenthesize(
            [
                generateExpression(left, {
                    precedence: Precedence.Call,
                    allowIn: allowIn,
                    allowCall: true
                }),
                space + operator + space,
                generateExpression(right, {
                    precedence: Precedence.Assignment,
                    allowIn: allowIn,
                    allowCall: true
                })
            ],
            Precedence.Assignment,
            precedence
        );
    }

    function generateExpression(expr, option) {
        var result,
            precedence,
            type,
            currentPrecedence,
            i,
            len,
            fragment,
            multiline,
            leftCharCode,
            leftSource,
            rightCharCode,
            allowIn,
            allowCall,
            allowUnparenthesizedNew,
            property,
            isGenerator;

        precedence = option.precedence;
        allowIn = option.allowIn;
        allowCall = option.allowCall;
        type = expr.type || option.type;

        if (extra.verbatim && expr.hasOwnProperty(extra.verbatim)) {
            return generateVerbatim(expr, option);
        }

        switch (type) {
        case Syntax.SequenceExpression:
            result = [];
            allowIn |= (Precedence.Sequence < precedence);
            for (i = 0, len = expr.expressions.length; i < len; ++i) {
                result.push(generateExpression(expr.expressions[i], {
                    precedence: Precedence.Assignment,
                    allowIn: allowIn,
                    allowCall: true
                }));
                if (i + 1 < len) {
                    result.push(',' + space);
                }
            }
            result = parenthesize(result, Precedence.Sequence, precedence);
            break;

        case Syntax.AssignmentExpression:
            result = generateAssignment(expr.left, expr.right, expr.operator, option);
            break;

        case Syntax.ArrowFunctionExpression:
            allowIn |= (Precedence.ArrowFunction < precedence);
            result = parenthesize(generateFunctionBody(expr), Precedence.ArrowFunction, precedence);
            break;

        case Syntax.ConditionalExpression:
            allowIn |= (Precedence.Conditional < precedence);
            result = parenthesize(
                [
                    generateExpression(expr.test, {
                        precedence: Precedence.LogicalOR,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space + '?' + space,
                    generateExpression(expr.consequent, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space + ':' + space,
                    generateExpression(expr.alternate, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    })
                ],
                Precedence.Conditional,
                precedence
            );
            break;

        case Syntax.LogicalExpression:
        case Syntax.BinaryExpression:
            currentPrecedence = BinaryPrecedence[expr.operator];

            allowIn |= (currentPrecedence < precedence);

            fragment = generateExpression(expr.left, {
                precedence: currentPrecedence,
                allowIn: allowIn,
                allowCall: true
            });

            leftSource = fragment.toString();

            if (leftSource.charCodeAt(leftSource.length - 1) === 0x2F /* / */ && esutils.code.isIdentifierPart(expr.operator.charCodeAt(0))) {
                result = [fragment, noEmptySpace(), expr.operator];
            } else {
                result = join(fragment, expr.operator);
            }

            fragment = generateExpression(expr.right, {
                precedence: currentPrecedence + 1,
                allowIn: allowIn,
                allowCall: true
            });

            if (expr.operator === '/' && fragment.toString().charAt(0) === '/' ||
            expr.operator.slice(-1) === '<' && fragment.toString().slice(0, 3) === '!--') {
                // If '/' concats with '/' or `<` concats with `!--`, it is interpreted as comment start
                result.push(noEmptySpace());
                result.push(fragment);
            } else {
                result = join(result, fragment);
            }

            if (expr.operator === 'in' && !allowIn) {
                result = ['(', result, ')'];
            } else {
                result = parenthesize(result, currentPrecedence, precedence);
            }

            break;

        case Syntax.CallExpression:
            result = [generateExpression(expr.callee, {
                precedence: Precedence.Call,
                allowIn: true,
                allowCall: true,
                allowUnparenthesizedNew: false
            })];

            result.push('(');
            for (i = 0, len = expr['arguments'].length; i < len; ++i) {
                result.push(generateExpression(expr['arguments'][i], {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                }));
                if (i + 1 < len) {
                    result.push(',' + space);
                }
            }
            result.push(')');

            if (!allowCall) {
                result = ['(', result, ')'];
            } else {
                result = parenthesize(result, Precedence.Call, precedence);
            }
            break;

        case Syntax.NewExpression:
            len = expr['arguments'].length;
            allowUnparenthesizedNew = option.allowUnparenthesizedNew === undefined || option.allowUnparenthesizedNew;

            result = join(
                'new',
                generateExpression(expr.callee, {
                    precedence: Precedence.New,
                    allowIn: true,
                    allowCall: false,
                    allowUnparenthesizedNew: allowUnparenthesizedNew && !parentheses && len === 0
                })
            );

            if (!allowUnparenthesizedNew || parentheses || len > 0) {
                result.push('(');
                for (i = 0; i < len; ++i) {
                    result.push(generateExpression(expr['arguments'][i], {
                        precedence: Precedence.Assignment,
                        allowIn: true,
                        allowCall: true
                    }));
                    if (i + 1 < len) {
                        result.push(',' + space);
                    }
                }
                result.push(')');
            }

            result = parenthesize(result, Precedence.New, precedence);
            break;

        case Syntax.MemberExpression:
            result = [generateExpression(expr.object, {
                precedence: Precedence.Call,
                allowIn: true,
                allowCall: allowCall,
                allowUnparenthesizedNew: false
            })];

            if (expr.computed) {
                result.push('[');
                result.push(generateExpression(expr.property, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: allowCall
                }));
                result.push(']');
            } else {
                if (expr.object.type === Syntax.Literal && typeof expr.object.value === 'number') {
                    fragment = toSourceNodeWhenNeeded(result).toString();
                    // When the following conditions are all true,
                    //   1. No floating point
                    //   2. Don't have exponents
                    //   3. The last character is a decimal digit
                    //   4. Not hexadecimal OR octal number literal
                    // we should add a floating point.
                    if (
                            fragment.indexOf('.') < 0 &&
                            !/[eExX]/.test(fragment) &&
                            esutils.code.isDecimalDigit(fragment.charCodeAt(fragment.length - 1)) &&
                            !(fragment.length >= 2 && fragment.charCodeAt(0) === 48)  // '0'
                            ) {
                        result.push('.');
                    }
                }
                result.push('.');
                result.push(generateIdentifier(expr.property));
            }

            result = parenthesize(result, Precedence.Member, precedence);
            break;

        case Syntax.UnaryExpression:
            fragment = generateExpression(expr.argument, {
                precedence: Precedence.Unary,
                allowIn: true,
                allowCall: true
            });

            if (space === '') {
                result = join(expr.operator, fragment);
            } else {
                result = [expr.operator];
                if (expr.operator.length > 2) {
                    // delete, void, typeof
                    // get `typeof []`, not `typeof[]`
                    result = join(result, fragment);
                } else {
                    // Prevent inserting spaces between operator and argument if it is unnecessary
                    // like, `!cond`
                    leftSource = toSourceNodeWhenNeeded(result).toString();
                    leftCharCode = leftSource.charCodeAt(leftSource.length - 1);
                    rightCharCode = fragment.toString().charCodeAt(0);

                    if (((leftCharCode === 0x2B  /* + */ || leftCharCode === 0x2D  /* - */) && leftCharCode === rightCharCode) ||
                            (esutils.code.isIdentifierPart(leftCharCode) && esutils.code.isIdentifierPart(rightCharCode))) {
                        result.push(noEmptySpace());
                        result.push(fragment);
                    } else {
                        result.push(fragment);
                    }
                }
            }
            result = parenthesize(result, Precedence.Unary, precedence);
            break;

        case Syntax.YieldExpression:
            if (expr.delegate) {
                result = 'yield*';
            } else {
                result = 'yield';
            }
            if (expr.argument) {
                result = join(
                    result,
                    generateExpression(expr.argument, {
                        precedence: Precedence.Yield,
                        allowIn: true,
                        allowCall: true
                    })
                );
            }
            result = parenthesize(result, Precedence.Yield, precedence);
            break;

        case Syntax.UpdateExpression:
            if (expr.prefix) {
                result = parenthesize(
                    [
                        expr.operator,
                        generateExpression(expr.argument, {
                            precedence: Precedence.Unary,
                            allowIn: true,
                            allowCall: true
                        })
                    ],
                    Precedence.Unary,
                    precedence
                );
            } else {
                result = parenthesize(
                    [
                        generateExpression(expr.argument, {
                            precedence: Precedence.Postfix,
                            allowIn: true,
                            allowCall: true
                        }),
                        expr.operator
                    ],
                    Precedence.Postfix,
                    precedence
                );
            }
            break;

        case Syntax.FunctionExpression:
            isGenerator = expr.generator && !extra.moz.starlessGenerator;
            result = isGenerator ? 'function*' : 'function';

            if (expr.id) {
                result = [result, (isGenerator) ? space : noEmptySpace(),
                          generateIdentifier(expr.id),
                          generateFunctionBody(expr)];
            } else {
                result = [result + space, generateFunctionBody(expr)];
            }
            break;

        case Syntax.ExportBatchSpecifier:
            result = '*';
            break;

        case Syntax.ArrayPattern:
        case Syntax.ArrayExpression:
            if (!expr.elements.length) {
                result = '[]';
                break;
            }
            multiline = expr.elements.length > 1;
            result = ['[', multiline ? newline : ''];
            withIndent(function (indent) {
                for (i = 0, len = expr.elements.length; i < len; ++i) {
                    if (!expr.elements[i]) {
                        if (multiline) {
                            result.push(indent);
                        }
                        if (i + 1 === len) {
                            result.push(',');
                        }
                    } else {
                        result.push(multiline ? indent : '');
                        result.push(generateExpression(expr.elements[i], {
                            precedence: Precedence.Assignment,
                            allowIn: true,
                            allowCall: true
                        }));
                    }
                    if (i + 1 < len) {
                        result.push(',' + (multiline ? newline : space));
                    }
                }
            });
            if (multiline && !endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                result.push(newline);
            }
            result.push(multiline ? base : '');
            result.push(']');
            break;

        case Syntax.ClassExpression:
            result = ['class'];
            if (expr.id) {
                result = join(result, generateExpression(expr.id, {
                    allowIn: true,
                    allowCall: true
                }));
            }
            if (expr.superClass) {
                fragment = join('extends', generateExpression(expr.superClass, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                }));
                result = join(result, fragment);
            }
            result.push(space);
            result.push(generateStatement(expr.body, {
                semicolonOptional: true,
                directiveContext: false
            }));
            break;

        case Syntax.MethodDefinition:
            if (expr['static']) {
                result = ['static' + space];
            } else {
                result = [];
            }

            if (expr.kind === 'get' || expr.kind === 'set') {
                result = join(result, [
                    join(expr.kind, generatePropertyKey(expr.key, expr.computed, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    })),
                    generateFunctionBody(expr.value)
                ]);
            } else {
                fragment = [
                    generatePropertyKey(expr.key, expr.computed, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    generateFunctionBody(expr.value)
                ];
                if (expr.value.generator) {
                    result.push('*');
                    result.push(fragment);
                } else {
                    result = join(result, fragment);
                }
            }
            break;

        case Syntax.Property:
            if (expr.kind === 'get' || expr.kind === 'set') {
                result = [
                    expr.kind, noEmptySpace(),
                    generatePropertyKey(expr.key, expr.computed, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    generateFunctionBody(expr.value)
                ];
            } else {
                if (expr.shorthand) {
                    result = generatePropertyKey(expr.key, expr.computed, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    });
                } else if (expr.method) {
                    result = [];
                    if (expr.value.generator) {
                        result.push('*');
                    }
                    result.push(generatePropertyKey(expr.key, expr.computed, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                    result.push(generateFunctionBody(expr.value));
                } else {
                    result = [
                        generatePropertyKey(expr.key, expr.computed, {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true
                        }),
                        ':' + space,
                        generateExpression(expr.value, {
                            precedence: Precedence.Assignment,
                            allowIn: true,
                            allowCall: true
                        })
                    ];
                }
            }
            break;

        case Syntax.ObjectExpression:
            if (!expr.properties.length) {
                result = '{}';
                break;
            }
            multiline = expr.properties.length > 1;

            withIndent(function () {
                fragment = generateExpression(expr.properties[0], {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true,
                    type: Syntax.Property
                });
            });

            if (!multiline) {
                // issues 4
                // Do not transform from
                //   dejavu.Class.declare({
                //       method2: function () {}
                //   });
                // to
                //   dejavu.Class.declare({method2: function () {
                //       }});
                if (!hasLineTerminator(toSourceNodeWhenNeeded(fragment).toString())) {
                    result = [ '{', space, fragment, space, '}' ];
                    break;
                }
            }

            withIndent(function (indent) {
                result = [ '{', newline, indent, fragment ];

                if (multiline) {
                    result.push(',' + newline);
                    for (i = 1, len = expr.properties.length; i < len; ++i) {
                        result.push(indent);
                        result.push(generateExpression(expr.properties[i], {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true,
                            type: Syntax.Property
                        }));
                        if (i + 1 < len) {
                            result.push(',' + newline);
                        }
                    }
                }
            });

            if (!endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                result.push(newline);
            }
            result.push(base);
            result.push('}');
            break;

        case Syntax.ObjectPattern:
            if (!expr.properties.length) {
                result = '{}';
                break;
            }

            multiline = false;
            if (expr.properties.length === 1) {
                property = expr.properties[0];
                if (property.value.type !== Syntax.Identifier) {
                    multiline = true;
                }
            } else {
                for (i = 0, len = expr.properties.length; i < len; ++i) {
                    property = expr.properties[i];
                    if (!property.shorthand) {
                        multiline = true;
                        break;
                    }
                }
            }
            result = ['{', multiline ? newline : '' ];

            withIndent(function (indent) {
                for (i = 0, len = expr.properties.length; i < len; ++i) {
                    result.push(multiline ? indent : '');
                    result.push(generateExpression(expr.properties[i], {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                    if (i + 1 < len) {
                        result.push(',' + (multiline ? newline : space));
                    }
                }
            });

            if (multiline && !endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                result.push(newline);
            }
            result.push(multiline ? base : '');
            result.push('}');
            break;

        case Syntax.ThisExpression:
            result = 'this';
            break;

        case Syntax.Identifier:
            result = generateIdentifier(expr);
            break;

        case Syntax.ImportSpecifier:
        case Syntax.ExportSpecifier:
            result = [ expr.id.name ];
            if (expr.name) {
                result.push(noEmptySpace() + 'as' + noEmptySpace() + expr.name.name);
            }
            break;

        case Syntax.Literal:
            result = generateLiteral(expr);
            break;

        case Syntax.GeneratorExpression:
        case Syntax.ComprehensionExpression:
            // GeneratorExpression should be parenthesized with (...), ComprehensionExpression with [...]
            // Due to https://bugzilla.mozilla.org/show_bug.cgi?id=883468 position of expr.body can differ in Spidermonkey and ES6
            result = (type === Syntax.GeneratorExpression) ? ['('] : ['['];

            if (extra.moz.comprehensionExpressionStartsWithAssignment) {
                fragment = generateExpression(expr.body, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                });

                result.push(fragment);
            }

            if (expr.blocks) {
                withIndent(function () {
                    for (i = 0, len = expr.blocks.length; i < len; ++i) {
                        fragment = generateExpression(expr.blocks[i], {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true
                        });

                        if (i > 0 || extra.moz.comprehensionExpressionStartsWithAssignment) {
                            result = join(result, fragment);
                        } else {
                            result.push(fragment);
                        }
                    }
                });
            }

            if (expr.filter) {
                result = join(result, 'if' + space);
                fragment = generateExpression(expr.filter, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                });
                result = join(result, [ '(', fragment, ')' ]);
            }

            if (!extra.moz.comprehensionExpressionStartsWithAssignment) {
                fragment = generateExpression(expr.body, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                });

                result = join(result, fragment);
            }

            result.push((type === Syntax.GeneratorExpression) ? ')' : ']');
            break;

        case Syntax.ComprehensionBlock:
            if (expr.left.type === Syntax.VariableDeclaration) {
                fragment = [
                    expr.left.kind, noEmptySpace(),
                    generateStatement(expr.left.declarations[0], {
                        allowIn: false
                    })
                ];
            } else {
                fragment = generateExpression(expr.left, {
                    precedence: Precedence.Call,
                    allowIn: true,
                    allowCall: true
                });
            }

            fragment = join(fragment, expr.of ? 'of' : 'in');
            fragment = join(fragment, generateExpression(expr.right, {
                precedence: Precedence.Sequence,
                allowIn: true,
                allowCall: true
            }));

            result = [ 'for' + space + '(', fragment, ')' ];
            break;

        case Syntax.SpreadElement:
            result = [
                '...',
                generateExpression(expr.argument, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                })
            ];
            break;

        case Syntax.TaggedTemplateExpression:
            result = [
                generateExpression(expr.tag, {
                    precedence: Precedence.Call,
                    allowIn: true,
                    allowCall: allowCall,
                    allowUnparenthesizedNew: false
                }),
                generateExpression(expr.quasi, {
                    precedence: Precedence.Primary
                })
            ];
            result = parenthesize(result, Precedence.TaggedTemplate, precedence);
            break;

        case Syntax.TemplateElement:
            // Don't use "cooked". Since tagged template can use raw template
            // representation. So if we do so, it breaks the script semantics.
            result = expr.value.raw;
            break;

        case Syntax.TemplateLiteral:
            result = [ '`' ];
            for (i = 0, len = expr.quasis.length; i < len; ++i) {
                result.push(generateExpression(expr.quasis[i], {
                    precedence: Precedence.Primary,
                    allowIn: true,
                    allowCall: true
                }));
                if (i + 1 < len) {
                    result.push('${' + space);
                    result.push(generateExpression(expr.expressions[i], {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                    result.push(space + '}');
                }
            }
            result.push('`');
            break;

        default:
            throw new Error('Unknown expression type: ' + expr.type);
        }

        if (extra.comment) {
            result = addComments(expr,result);
        }
        return toSourceNodeWhenNeeded(result, expr);
    }

    // ES6: 15.2.1 valid import declarations:
    //     - import ImportClause FromClause ;
    //     - import ModuleSpecifier ;
    function generateImportDeclaration(stmt, semicolon) {
        var result, namedStart;

        // If no ImportClause is present,
        // this should be `import ModuleSpecifier` so skip `from`
        // ModuleSpecifier is StringLiteral.
        if (stmt.specifiers.length === 0) {
            // import ModuleSpecifier ;
            return [
                'import',
                space,
                generateLiteral(stmt.source),
                semicolon
            ];
        }

        // import ImportClause FromClause ;
        result = [
            'import'
        ];
        namedStart = 0;

        // ImportedBinding
        if (stmt.specifiers[0]['default']) {
            result = join(result, [
                    stmt.specifiers[0].id.name
            ]);
            ++namedStart;
        }

        // NamedImports
        if (stmt.specifiers[namedStart]) {
            if (namedStart !== 0) {
                result.push(',');
            }
            result.push(space + '{');

            if ((stmt.specifiers.length - namedStart) === 1) {
                // import { ... } from "...";
                result.push(space);
                result.push(generateExpression(stmt.specifiers[namedStart], {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                }));
                result.push(space + '}' + space);
            } else {
                // import {
                //    ...,
                //    ...,
                // } from "...";
                withIndent(function (indent) {
                    var i, iz;
                    result.push(newline);
                    for (i = namedStart, iz = stmt.specifiers.length; i < iz; ++i) {
                        result.push(indent);
                        result.push(generateExpression(stmt.specifiers[i], {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true
                        }));
                        if (i + 1 < iz) {
                            result.push(',' + newline);
                        }
                    }
                });
                if (!endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                    result.push(newline);
                }
                result.push(base + '}' + space);
            }
        }

        result = join(result, [
            'from' + space,
            generateLiteral(stmt.source),
            semicolon
        ]);
        return result;
    }

    function generateStatement(stmt, option) {
        var i,
            len,
            result,
            allowIn,
            functionBody,
            directiveContext,
            fragment,
            semicolon,
            isGenerator,
            guardedHandlers;

        allowIn = true;
        semicolon = ';';
        functionBody = false;
        directiveContext = false;
        if (option) {
            allowIn = option.allowIn === undefined || option.allowIn;
            if (!semicolons && option.semicolonOptional === true) {
                semicolon = '';
            }
            functionBody = option.functionBody;
            directiveContext = option.directiveContext;
        }

        switch (stmt.type) {
        case Syntax.BlockStatement:
            result = ['{', newline];

            withIndent(function () {
                for (i = 0, len = stmt.body.length; i < len; ++i) {
                    fragment = addIndent(generateStatement(stmt.body[i], {
                        semicolonOptional: i === len - 1,
                        directiveContext: functionBody
                    }));
                    result.push(fragment);
                    if (!endsWithLineTerminator(toSourceNodeWhenNeeded(fragment).toString())) {
                        result.push(newline);
                    }
                }
            });

            result.push(addIndent('}'));
            break;

        case Syntax.BreakStatement:
            if (stmt.label) {
                result = 'break ' + stmt.label.name + semicolon;
            } else {
                result = 'break' + semicolon;
            }
            break;

        case Syntax.ContinueStatement:
            if (stmt.label) {
                result = 'continue ' + stmt.label.name + semicolon;
            } else {
                result = 'continue' + semicolon;
            }
            break;

        case Syntax.ClassBody:
            result = generateClassBody(stmt);
            break;

        case Syntax.ClassDeclaration:
            result = ['class ' + stmt.id.name];
            if (stmt.superClass) {
                fragment = join('extends', generateExpression(stmt.superClass, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                }));
                result = join(result, fragment);
            }
            result.push(space);
            result.push(generateStatement(stmt.body, {
                semicolonOptional: true,
                directiveContext: false
            }));
            break;

        case Syntax.DirectiveStatement:
            if (extra.raw && stmt.raw) {
                result = stmt.raw + semicolon;
            } else {
                result = escapeDirective(stmt.directive) + semicolon;
            }
            break;

        case Syntax.DoWhileStatement:
            // Because `do 42 while (cond)` is Syntax Error. We need semicolon.
            result = join('do', maybeBlock(stmt.body));
            result = maybeBlockSuffix(stmt.body, result);
            result = join(result, [
                'while' + space + '(',
                generateExpression(stmt.test, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                }),
                ')' + semicolon
            ]);
            break;

        case Syntax.CatchClause:
            withIndent(function () {
                var guard;

                result = [
                    'catch' + space + '(',
                    generateExpression(stmt.param, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];

                if (stmt.guard) {
                    guard = generateExpression(stmt.guard, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    });

                    result.splice(2, 0, ' if ', guard);
                }
            });
            result.push(maybeBlock(stmt.body));
            break;

        case Syntax.DebuggerStatement:
            result = 'debugger' + semicolon;
            break;

        case Syntax.EmptyStatement:
            result = ';';
            break;

        case Syntax.ExportDeclaration:
            result = [ 'export' ];

            // export default AssignmentExpression[In] ;
            if (stmt['default']) {
                result = join(result, 'default');
                result = join(result, generateExpression(stmt.declaration, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                }) + semicolon);
                break;
            }

            // export * FromClause ;
            // export ExportClause[NoReference] FromClause ;
            // export ExportClause ;
            if (stmt.specifiers) {
                if (stmt.specifiers.length === 0) {
                    result = join(result, '{' + space + '}');
                } else if (stmt.specifiers[0].type === Syntax.ExportBatchSpecifier) {
                    result = join(result, generateExpression(stmt.specifiers[0], {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                } else {
                    result = join(result, '{');
                    withIndent(function (indent) {
                        var i, iz;
                        result.push(newline);
                        for (i = 0, iz = stmt.specifiers.length; i < iz; ++i) {
                            result.push(indent);
                            result.push(generateExpression(stmt.specifiers[i], {
                                precedence: Precedence.Sequence,
                                allowIn: true,
                                allowCall: true
                            }));
                            if (i + 1 < iz) {
                                result.push(',' + newline);
                            }
                        }
                    });
                    if (!endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                        result.push(newline);
                    }
                    result.push(base + '}');
                }
                if (stmt.source) {
                    result = join(result, [
                        'from' + space,
                        generateLiteral(stmt.source),
                        semicolon
                    ]);
                } else {
                    result.push(semicolon);
                }
                break;
            }

            // export VariableStatement
            // export Declaration[Default]
            if (stmt.declaration) {
                result = join(result, generateStatement(stmt.declaration, { semicolonOptional: semicolon === '' }));
            }
            break;

        case Syntax.ExpressionStatement:
            result = [generateExpression(stmt.expression, {
                precedence: Precedence.Sequence,
                allowIn: true,
                allowCall: true
            })];
            // 12.4 '{', 'function', 'class' is not allowed in this position.
            // wrap expression with parentheses
            fragment = toSourceNodeWhenNeeded(result).toString();
            if (fragment.charAt(0) === '{' ||  // ObjectExpression
                    (fragment.slice(0, 5) === 'class' && ' {'.indexOf(fragment.charAt(5)) >= 0) ||  // class
                    (fragment.slice(0, 8) === 'function' && '* ('.indexOf(fragment.charAt(8)) >= 0) ||  // function or generator
                    (directive && directiveContext && stmt.expression.type === Syntax.Literal && typeof stmt.expression.value === 'string')) {
                result = ['(', result, ')' + semicolon];
            } else {
                result.push(semicolon);
            }
            break;

        case Syntax.ImportDeclaration:
            result = generateImportDeclaration(stmt, semicolon);
            break;

        case Syntax.VariableDeclarator:
            if (stmt.init) {
                result = [
                    generateExpression(stmt.id, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space,
                    '=',
                    space,
                    generateExpression(stmt.init, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    })
                ];
            } else {
                result = generatePattern(stmt.id, {
                    precedence: Precedence.Assignment,
                    allowIn: allowIn
                });
            }
            break;

        case Syntax.VariableDeclaration:
            // VariableDeclarator is typed as Statement,
            // but joined with comma (not LineTerminator).
            // So if comment is attached to target node, we should specialize.
            result = generateVariableDeclaration(stmt, semicolon, allowIn);
            break;

        case Syntax.ThrowStatement:
            result = [join(
                'throw',
                generateExpression(stmt.argument, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                })
            ), semicolon];
            break;

        case Syntax.TryStatement:
            result = ['try', maybeBlock(stmt.block)];
            result = maybeBlockSuffix(stmt.block, result);

            if (stmt.handlers) {
                // old interface
                for (i = 0, len = stmt.handlers.length; i < len; ++i) {
                    result = join(result, generateStatement(stmt.handlers[i]));
                    if (stmt.finalizer || i + 1 !== len) {
                        result = maybeBlockSuffix(stmt.handlers[i].body, result);
                    }
                }
            } else {
                guardedHandlers = stmt.guardedHandlers || [];

                for (i = 0, len = guardedHandlers.length; i < len; ++i) {
                    result = join(result, generateStatement(guardedHandlers[i]));
                    if (stmt.finalizer || i + 1 !== len) {
                        result = maybeBlockSuffix(guardedHandlers[i].body, result);
                    }
                }

                // new interface
                if (stmt.handler) {
                    if (isArray(stmt.handler)) {
                        for (i = 0, len = stmt.handler.length; i < len; ++i) {
                            result = join(result, generateStatement(stmt.handler[i]));
                            if (stmt.finalizer || i + 1 !== len) {
                                result = maybeBlockSuffix(stmt.handler[i].body, result);
                            }
                        }
                    } else {
                        result = join(result, generateStatement(stmt.handler));
                        if (stmt.finalizer) {
                            result = maybeBlockSuffix(stmt.handler.body, result);
                        }
                    }
                }
            }
            if (stmt.finalizer) {
                result = join(result, ['finally', maybeBlock(stmt.finalizer)]);
            }
            break;

        case Syntax.SwitchStatement:
            withIndent(function () {
                result = [
                    'switch' + space + '(',
                    generateExpression(stmt.discriminant, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')' + space + '{' + newline
                ];
            });
            if (stmt.cases) {
                for (i = 0, len = stmt.cases.length; i < len; ++i) {
                    fragment = addIndent(generateStatement(stmt.cases[i], {semicolonOptional: i === len - 1}));
                    result.push(fragment);
                    if (!endsWithLineTerminator(toSourceNodeWhenNeeded(fragment).toString())) {
                        result.push(newline);
                    }
                }
            }
            result.push(addIndent('}'));
            break;

        case Syntax.SwitchCase:
            withIndent(function () {
                if (stmt.test) {
                    result = [
                        join('case', generateExpression(stmt.test, {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true
                        })),
                        ':'
                    ];
                } else {
                    result = ['default:'];
                }

                i = 0;
                len = stmt.consequent.length;
                if (len && stmt.consequent[0].type === Syntax.BlockStatement) {
                    fragment = maybeBlock(stmt.consequent[0]);
                    result.push(fragment);
                    i = 1;
                }

                if (i !== len && !endsWithLineTerminator(toSourceNodeWhenNeeded(result).toString())) {
                    result.push(newline);
                }

                for (; i < len; ++i) {
                    fragment = addIndent(generateStatement(stmt.consequent[i], {semicolonOptional: i === len - 1 && semicolon === ''}));
                    result.push(fragment);
                    if (i + 1 !== len && !endsWithLineTerminator(toSourceNodeWhenNeeded(fragment).toString())) {
                        result.push(newline);
                    }
                }
            });
            break;

        case Syntax.IfStatement:
            withIndent(function () {
                result = [
                    'if' + space + '(',
                    generateExpression(stmt.test, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            if (stmt.alternate) {
                result.push(maybeBlock(stmt.consequent));
                result = maybeBlockSuffix(stmt.consequent, result);
                if (stmt.alternate.type === Syntax.IfStatement) {
                    result = join(result, ['else ', generateStatement(stmt.alternate, {semicolonOptional: semicolon === ''})]);
                } else {
                    result = join(result, join('else', maybeBlock(stmt.alternate, semicolon === '')));
                }
            } else {
                result.push(maybeBlock(stmt.consequent, semicolon === ''));
            }
            break;

        case Syntax.ForStatement:
            withIndent(function () {
                result = ['for' + space + '('];
                if (stmt.init) {
                    if (stmt.init.type === Syntax.VariableDeclaration) {
                        result.push(generateStatement(stmt.init, {allowIn: false}));
                    } else {
                        result.push(generateExpression(stmt.init, {
                            precedence: Precedence.Sequence,
                            allowIn: false,
                            allowCall: true
                        }));
                        result.push(';');
                    }
                } else {
                    result.push(';');
                }

                if (stmt.test) {
                    result.push(space);
                    result.push(generateExpression(stmt.test, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                    result.push(';');
                } else {
                    result.push(';');
                }

                if (stmt.update) {
                    result.push(space);
                    result.push(generateExpression(stmt.update, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                    result.push(')');
                } else {
                    result.push(')');
                }
            });

            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        case Syntax.ForInStatement:
            result = generateIterationForStatement('in', stmt, semicolon === '');
            break;

        case Syntax.ForOfStatement:
            result = generateIterationForStatement('of', stmt, semicolon === '');
            break;

        case Syntax.LabeledStatement:
            result = [stmt.label.name + ':', maybeBlock(stmt.body, semicolon === '')];
            break;

        case Syntax.ModuleDeclaration:
            result = [
                'module',
                noEmptySpace(),
                stmt.id.name,
                noEmptySpace(),
                'from',
                space,
                generateLiteral(stmt.source),
                semicolon
            ];
            break;

        case Syntax.Program:
            len = stmt.body.length;
            result = [safeConcatenation && len > 0 ? '\n' : ''];
            for (i = 0; i < len; ++i) {
                fragment = addIndent(
                    generateStatement(stmt.body[i], {
                        semicolonOptional: !safeConcatenation && i === len - 1,
                        directiveContext: true
                    })
                );
                result.push(fragment);
                if (i + 1 < len && !endsWithLineTerminator(toSourceNodeWhenNeeded(fragment).toString())) {
                    result.push(newline);
                }
            }
            break;

        case Syntax.FunctionDeclaration:
            isGenerator = stmt.generator && !extra.moz.starlessGenerator;
            result = [
                (isGenerator ? 'function*' : 'function'),
                (isGenerator ? space : noEmptySpace()),
                generateIdentifier(stmt.id),
                generateFunctionBody(stmt)
            ];
            break;

        case Syntax.ReturnStatement:
            if (stmt.argument) {
                result = [join(
                    'return',
                    generateExpression(stmt.argument, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    })
                ), semicolon];
            } else {
                result = ['return' + semicolon];
            }
            break;

        case Syntax.WhileStatement:
            withIndent(function () {
                result = [
                    'while' + space + '(',
                    generateExpression(stmt.test, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        case Syntax.WithStatement:
            withIndent(function () {
                result = [
                    'with' + space + '(',
                    generateExpression(stmt.object, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        default:
            throw new Error('Unknown statement type: ' + stmt.type);
        }

        // Attach comments

        if (extra.comment) {
            result = addComments(stmt, result);
        }

        fragment = toSourceNodeWhenNeeded(result).toString();
        if (stmt.type === Syntax.Program && !safeConcatenation && newline === '' &&  fragment.charAt(fragment.length - 1) === '\n') {
            result = sourceMap ? toSourceNodeWhenNeeded(result).replaceRight(/\s+$/, '') : fragment.replace(/\s+$/, '');
        }

        return toSourceNodeWhenNeeded(result, stmt);
    }

    function generateInternal(node) {
        if (isStatement(node)) {
            return generateStatement(node);
        }

        if (isExpression(node)) {
            return generateExpression(node, {
                precedence: Precedence.Sequence,
                allowIn: true,
                allowCall: true
            });
        }

        throw new Error('Unknown node type: ' + node.type);
    }

    function generate(node, options) {
        var defaultOptions = getDefaultOptions(), result, pair;

        if (options != null) {
            // Obsolete options
            //
            //   `options.indent`
            //   `options.base`
            //
            // Instead of them, we can use `option.format.indent`.
            if (typeof options.indent === 'string') {
                defaultOptions.format.indent.style = options.indent;
            }
            if (typeof options.base === 'number') {
                defaultOptions.format.indent.base = options.base;
            }
            options = updateDeeply(defaultOptions, options);
            indent = options.format.indent.style;
            if (typeof options.base === 'string') {
                base = options.base;
            } else {
                base = stringRepeat(indent, options.format.indent.base);
            }
        } else {
            options = defaultOptions;
            indent = options.format.indent.style;
            base = stringRepeat(indent, options.format.indent.base);
        }
        json = options.format.json;
        renumber = options.format.renumber;
        hexadecimal = json ? false : options.format.hexadecimal;
        quotes = json ? 'double' : options.format.quotes;
        escapeless = options.format.escapeless;
        newline = options.format.newline;
        space = options.format.space;
        if (options.format.compact) {
            newline = space = indent = base = '';
        }
        parentheses = options.format.parentheses;
        semicolons = options.format.semicolons;
        safeConcatenation = options.format.safeConcatenation;
        directive = options.directive;
        parse = json ? null : options.parse;
        sourceMap = options.sourceMap;
        extra = options;

        if (sourceMap) {
            if (!exports.browser) {
                // We assume environment is node.js
                // And prevent from including source-map by browserify
                SourceNode = require('source-map').SourceNode;
            } else {
                SourceNode = global.sourceMap.SourceNode;
            }
        }

        result = generateInternal(node);

        if (!sourceMap) {
            pair = {code: result.toString(), map: null};
            return options.sourceMapWithCode ? pair : pair.code;
        }


        pair = result.toStringWithSourceMap({
            file: options.file,
            sourceRoot: options.sourceMapRoot
        });

        if (options.sourceContent) {
            pair.map.setSourceContent(options.sourceMap,
                                      options.sourceContent);
        }

        if (options.sourceMapWithCode) {
            return pair;
        }

        return pair.map.toString();
    }

    FORMAT_MINIFY = {
        indent: {
            style: '',
            base: 0
        },
        renumber: true,
        hexadecimal: true,
        quotes: 'auto',
        escapeless: true,
        compact: true,
        parentheses: false,
        semicolons: false
    };

    FORMAT_DEFAULTS = getDefaultOptions().format;

    exports.version = require('./package.json').version;
    exports.generate = generate;
    exports.attachComments = estraverse.attachComments;
    exports.Precedence = updateDeeply({}, Precedence);
    exports.browser = false;
    exports.FORMAT_MINIFY = FORMAT_MINIFY;
    exports.FORMAT_DEFAULTS = FORMAT_DEFAULTS;
}());
/* vim: set sw=4 ts=4 et tw=80 : */

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./package.json":25,"estraverse":10,"esutils":14,"source-map":15}],10:[function(require,module,exports){
/*
  Copyright (C) 2012-2013 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012 Ariya Hidayat <ariya.hidayat@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/*jslint vars:false, bitwise:true*/
/*jshint indent:4*/
/*global exports:true, define:true*/
(function (root, factory) {
    'use strict';

    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js,
    // and plain browser loading,
    if (typeof define === 'function' && define.amd) {
        define(['exports'], factory);
    } else if (typeof exports !== 'undefined') {
        factory(exports);
    } else {
        factory((root.estraverse = {}));
    }
}(this, function (exports) {
    'use strict';

    var Syntax,
        isArray,
        VisitorOption,
        VisitorKeys,
        BREAK,
        SKIP;

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        ArrayExpression: 'ArrayExpression',
        ArrayPattern: 'ArrayPattern',
        ArrowFunctionExpression: 'ArrowFunctionExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ClassBody: 'ClassBody',
        ClassDeclaration: 'ClassDeclaration',
        ClassExpression: 'ClassExpression',
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DebuggerStatement: 'DebuggerStatement',
        DirectiveStatement: 'DirectiveStatement',
        DoWhileStatement: 'DoWhileStatement',
        EmptyStatement: 'EmptyStatement',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForInStatement: 'ForInStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        MethodDefinition: 'MethodDefinition',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        ObjectPattern: 'ObjectPattern',
        Program: 'Program',
        Property: 'Property',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SwitchStatement: 'SwitchStatement',
        SwitchCase: 'SwitchCase',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement',
        YieldExpression: 'YieldExpression'
    };

    function ignoreJSHintError() { }

    isArray = Array.isArray;
    if (!isArray) {
        isArray = function isArray(array) {
            return Object.prototype.toString.call(array) === '[object Array]';
        };
    }

    function deepCopy(obj) {
        var ret = {}, key, val;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                val = obj[key];
                if (typeof val === 'object' && val !== null) {
                    ret[key] = deepCopy(val);
                } else {
                    ret[key] = val;
                }
            }
        }
        return ret;
    }

    function shallowCopy(obj) {
        var ret = {}, key;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                ret[key] = obj[key];
            }
        }
        return ret;
    }
    ignoreJSHintError(shallowCopy);

    // based on LLVM libc++ upper_bound / lower_bound
    // MIT License

    function upperBound(array, func) {
        var diff, len, i, current;

        len = array.length;
        i = 0;

        while (len) {
            diff = len >>> 1;
            current = i + diff;
            if (func(array[current])) {
                len = diff;
            } else {
                i = current + 1;
                len -= diff + 1;
            }
        }
        return i;
    }

    function lowerBound(array, func) {
        var diff, len, i, current;

        len = array.length;
        i = 0;

        while (len) {
            diff = len >>> 1;
            current = i + diff;
            if (func(array[current])) {
                i = current + 1;
                len -= diff + 1;
            } else {
                len = diff;
            }
        }
        return i;
    }
    ignoreJSHintError(lowerBound);

    VisitorKeys = {
        AssignmentExpression: ['left', 'right'],
        ArrayExpression: ['elements'],
        ArrayPattern: ['elements'],
        ArrowFunctionExpression: ['params', 'defaults', 'rest', 'body'],
        BlockStatement: ['body'],
        BinaryExpression: ['left', 'right'],
        BreakStatement: ['label'],
        CallExpression: ['callee', 'arguments'],
        CatchClause: ['param', 'body'],
        ClassBody: ['body'],
        ClassDeclaration: ['id', 'body', 'superClass'],
        ClassExpression: ['id', 'body', 'superClass'],
        ConditionalExpression: ['test', 'consequent', 'alternate'],
        ContinueStatement: ['label'],
        DebuggerStatement: [],
        DirectiveStatement: [],
        DoWhileStatement: ['body', 'test'],
        EmptyStatement: [],
        ExpressionStatement: ['expression'],
        ForStatement: ['init', 'test', 'update', 'body'],
        ForInStatement: ['left', 'right', 'body'],
        ForOfStatement: ['left', 'right', 'body'],
        FunctionDeclaration: ['id', 'params', 'defaults', 'rest', 'body'],
        FunctionExpression: ['id', 'params', 'defaults', 'rest', 'body'],
        Identifier: [],
        IfStatement: ['test', 'consequent', 'alternate'],
        Literal: [],
        LabeledStatement: ['label', 'body'],
        LogicalExpression: ['left', 'right'],
        MemberExpression: ['object', 'property'],
        MethodDefinition: ['key', 'value'],
        NewExpression: ['callee', 'arguments'],
        ObjectExpression: ['properties'],
        ObjectPattern: ['properties'],
        Program: ['body'],
        Property: ['key', 'value'],
        ReturnStatement: ['argument'],
        SequenceExpression: ['expressions'],
        SwitchStatement: ['discriminant', 'cases'],
        SwitchCase: ['test', 'consequent'],
        ThisExpression: [],
        ThrowStatement: ['argument'],
        TryStatement: ['block', 'handlers', 'handler', 'guardedHandlers', 'finalizer'],
        UnaryExpression: ['argument'],
        UpdateExpression: ['argument'],
        VariableDeclaration: ['declarations'],
        VariableDeclarator: ['id', 'init'],
        WhileStatement: ['test', 'body'],
        WithStatement: ['object', 'body'],
        YieldExpression: ['argument']
    };

    // unique id
    BREAK = {};
    SKIP = {};

    VisitorOption = {
        Break: BREAK,
        Skip: SKIP
    };

    function Reference(parent, key) {
        this.parent = parent;
        this.key = key;
    }

    Reference.prototype.replace = function replace(node) {
        this.parent[this.key] = node;
    };

    function Element(node, path, wrap, ref) {
        this.node = node;
        this.path = path;
        this.wrap = wrap;
        this.ref = ref;
    }

    function Controller() { }

    // API:
    // return property path array from root to current node
    Controller.prototype.path = function path() {
        var i, iz, j, jz, result, element;

        function addToPath(result, path) {
            if (isArray(path)) {
                for (j = 0, jz = path.length; j < jz; ++j) {
                    result.push(path[j]);
                }
            } else {
                result.push(path);
            }
        }

        // root node
        if (!this.__current.path) {
            return null;
        }

        // first node is sentinel, second node is root element
        result = [];
        for (i = 2, iz = this.__leavelist.length; i < iz; ++i) {
            element = this.__leavelist[i];
            addToPath(result, element.path);
        }
        addToPath(result, this.__current.path);
        return result;
    };

    // API:
    // return array of parent elements
    Controller.prototype.parents = function parents() {
        var i, iz, result;

        // first node is sentinel
        result = [];
        for (i = 1, iz = this.__leavelist.length; i < iz; ++i) {
            result.push(this.__leavelist[i].node);
        }

        return result;
    };

    // API:
    // return current node
    Controller.prototype.current = function current() {
        return this.__current.node;
    };

    Controller.prototype.__execute = function __execute(callback, element) {
        var previous, result;

        result = undefined;

        previous  = this.__current;
        this.__current = element;
        this.__state = null;
        if (callback) {
            result = callback.call(this, element.node, this.__leavelist[this.__leavelist.length - 1].node);
        }
        this.__current = previous;

        return result;
    };

    // API:
    // notify control skip / break
    Controller.prototype.notify = function notify(flag) {
        this.__state = flag;
    };

    // API:
    // skip child nodes of current node
    Controller.prototype.skip = function () {
        this.notify(SKIP);
    };

    // API:
    // break traversals
    Controller.prototype['break'] = function () {
        this.notify(BREAK);
    };

    Controller.prototype.__initialize = function(root, visitor) {
        this.visitor = visitor;
        this.root = root;
        this.__worklist = [];
        this.__leavelist = [];
        this.__current = null;
        this.__state = null;
    };

    Controller.prototype.traverse = function traverse(root, visitor) {
        var worklist,
            leavelist,
            element,
            node,
            nodeType,
            ret,
            key,
            current,
            current2,
            candidates,
            candidate,
            sentinel;

        this.__initialize(root, visitor);

        sentinel = {};

        // reference
        worklist = this.__worklist;
        leavelist = this.__leavelist;

        // initialize
        worklist.push(new Element(root, null, null, null));
        leavelist.push(new Element(null, null, null, null));

        while (worklist.length) {
            element = worklist.pop();

            if (element === sentinel) {
                element = leavelist.pop();

                ret = this.__execute(visitor.leave, element);

                if (this.__state === BREAK || ret === BREAK) {
                    return;
                }
                continue;
            }

            if (element.node) {

                ret = this.__execute(visitor.enter, element);

                if (this.__state === BREAK || ret === BREAK) {
                    return;
                }

                worklist.push(sentinel);
                leavelist.push(element);

                if (this.__state === SKIP || ret === SKIP) {
                    continue;
                }

                node = element.node;
                nodeType = element.wrap || node.type;
                candidates = VisitorKeys[nodeType];

                current = candidates.length;
                while ((current -= 1) >= 0) {
                    key = candidates[current];
                    candidate = node[key];
                    if (!candidate) {
                        continue;
                    }

                    if (!isArray(candidate)) {
                        worklist.push(new Element(candidate, key, null, null));
                        continue;
                    }

                    current2 = candidate.length;
                    while ((current2 -= 1) >= 0) {
                        if (!candidate[current2]) {
                            continue;
                        }
                        if ((nodeType === Syntax.ObjectExpression || nodeType === Syntax.ObjectPattern) && 'properties' === candidates[current]) {
                            element = new Element(candidate[current2], [key, current2], 'Property', null);
                        } else {
                            element = new Element(candidate[current2], [key, current2], null, null);
                        }
                        worklist.push(element);
                    }
                }
            }
        }
    };

    Controller.prototype.replace = function replace(root, visitor) {
        var worklist,
            leavelist,
            node,
            nodeType,
            target,
            element,
            current,
            current2,
            candidates,
            candidate,
            sentinel,
            outer,
            key;

        this.__initialize(root, visitor);

        sentinel = {};

        // reference
        worklist = this.__worklist;
        leavelist = this.__leavelist;

        // initialize
        outer = {
            root: root
        };
        element = new Element(root, null, null, new Reference(outer, 'root'));
        worklist.push(element);
        leavelist.push(element);

        while (worklist.length) {
            element = worklist.pop();

            if (element === sentinel) {
                element = leavelist.pop();

                target = this.__execute(visitor.leave, element);

                // node may be replaced with null,
                // so distinguish between undefined and null in this place
                if (target !== undefined && target !== BREAK && target !== SKIP) {
                    // replace
                    element.ref.replace(target);
                }

                if (this.__state === BREAK || target === BREAK) {
                    return outer.root;
                }
                continue;
            }

            target = this.__execute(visitor.enter, element);

            // node may be replaced with null,
            // so distinguish between undefined and null in this place
            if (target !== undefined && target !== BREAK && target !== SKIP) {
                // replace
                element.ref.replace(target);
                element.node = target;
            }

            if (this.__state === BREAK || target === BREAK) {
                return outer.root;
            }

            // node may be null
            node = element.node;
            if (!node) {
                continue;
            }

            worklist.push(sentinel);
            leavelist.push(element);

            if (this.__state === SKIP || target === SKIP) {
                continue;
            }

            nodeType = element.wrap || node.type;
            candidates = VisitorKeys[nodeType];

            current = candidates.length;
            while ((current -= 1) >= 0) {
                key = candidates[current];
                candidate = node[key];
                if (!candidate) {
                    continue;
                }

                if (!isArray(candidate)) {
                    worklist.push(new Element(candidate, key, null, new Reference(node, key)));
                    continue;
                }

                current2 = candidate.length;
                while ((current2 -= 1) >= 0) {
                    if (!candidate[current2]) {
                        continue;
                    }
                    if (nodeType === Syntax.ObjectExpression && 'properties' === candidates[current]) {
                        element = new Element(candidate[current2], [key, current2], 'Property', new Reference(candidate, current2));
                    } else {
                        element = new Element(candidate[current2], [key, current2], null, new Reference(candidate, current2));
                    }
                    worklist.push(element);
                }
            }
        }

        return outer.root;
    };

    function traverse(root, visitor) {
        var controller = new Controller();
        return controller.traverse(root, visitor);
    }

    function replace(root, visitor) {
        var controller = new Controller();
        return controller.replace(root, visitor);
    }

    function extendCommentRange(comment, tokens) {
        var target;

        target = upperBound(tokens, function search(token) {
            return token.range[0] > comment.range[0];
        });

        comment.extendedRange = [comment.range[0], comment.range[1]];

        if (target !== tokens.length) {
            comment.extendedRange[1] = tokens[target].range[0];
        }

        target -= 1;
        if (target >= 0) {
            comment.extendedRange[0] = tokens[target].range[1];
        }

        return comment;
    }

    function attachComments(tree, providedComments, tokens) {
        // At first, we should calculate extended comment ranges.
        var comments = [], comment, len, i, cursor;

        if (!tree.range) {
            throw new Error('attachComments needs range information');
        }

        // tokens array is empty, we attach comments to tree as 'leadingComments'
        if (!tokens.length) {
            if (providedComments.length) {
                for (i = 0, len = providedComments.length; i < len; i += 1) {
                    comment = deepCopy(providedComments[i]);
                    comment.extendedRange = [0, tree.range[0]];
                    comments.push(comment);
                }
                tree.leadingComments = comments;
            }
            return tree;
        }

        for (i = 0, len = providedComments.length; i < len; i += 1) {
            comments.push(extendCommentRange(deepCopy(providedComments[i]), tokens));
        }

        // This is based on John Freeman's implementation.
        cursor = 0;
        traverse(tree, {
            enter: function (node) {
                var comment;

                while (cursor < comments.length) {
                    comment = comments[cursor];
                    if (comment.extendedRange[1] > node.range[0]) {
                        break;
                    }

                    if (comment.extendedRange[1] === node.range[0]) {
                        if (!node.leadingComments) {
                            node.leadingComments = [];
                        }
                        node.leadingComments.push(comment);
                        comments.splice(cursor, 1);
                    } else {
                        cursor += 1;
                    }
                }

                // already out of owned node
                if (cursor === comments.length) {
                    return VisitorOption.Break;
                }

                if (comments[cursor].extendedRange[0] > node.range[1]) {
                    return VisitorOption.Skip;
                }
            }
        });

        cursor = 0;
        traverse(tree, {
            leave: function (node) {
                var comment;

                while (cursor < comments.length) {
                    comment = comments[cursor];
                    if (node.range[1] < comment.extendedRange[0]) {
                        break;
                    }

                    if (node.range[1] === comment.extendedRange[0]) {
                        if (!node.trailingComments) {
                            node.trailingComments = [];
                        }
                        node.trailingComments.push(comment);
                        comments.splice(cursor, 1);
                    } else {
                        cursor += 1;
                    }
                }

                // already out of owned node
                if (cursor === comments.length) {
                    return VisitorOption.Break;
                }

                if (comments[cursor].extendedRange[0] > node.range[1]) {
                    return VisitorOption.Skip;
                }
            }
        });

        return tree;
    }

    exports.version = '1.5.1-dev';
    exports.Syntax = Syntax;
    exports.traverse = traverse;
    exports.replace = replace;
    exports.attachComments = attachComments;
    exports.VisitorKeys = VisitorKeys;
    exports.VisitorOption = VisitorOption;
    exports.Controller = Controller;
}));
/* vim: set sw=4 ts=4 et tw=80 : */

},{}],11:[function(require,module,exports){
/*
  Copyright (C) 2013 Yusuke Suzuki <utatane.tea@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS 'AS IS'
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

(function () {
    'use strict';

    function isExpression(node) {
        if (node == null) { return false; }
        switch (node.type) {
            case 'ArrayExpression':
            case 'AssignmentExpression':
            case 'BinaryExpression':
            case 'CallExpression':
            case 'ConditionalExpression':
            case 'FunctionExpression':
            case 'Identifier':
            case 'Literal':
            case 'LogicalExpression':
            case 'MemberExpression':
            case 'NewExpression':
            case 'ObjectExpression':
            case 'SequenceExpression':
            case 'ThisExpression':
            case 'UnaryExpression':
            case 'UpdateExpression':
                return true;
        }
        return false;
    }

    function isIterationStatement(node) {
        if (node == null) { return false; }
        switch (node.type) {
            case 'DoWhileStatement':
            case 'ForInStatement':
            case 'ForStatement':
            case 'WhileStatement':
                return true;
        }
        return false;
    }

    function isStatement(node) {
        if (node == null) { return false; }
        switch (node.type) {
            case 'BlockStatement':
            case 'BreakStatement':
            case 'ContinueStatement':
            case 'DebuggerStatement':
            case 'DoWhileStatement':
            case 'EmptyStatement':
            case 'ExpressionStatement':
            case 'ForInStatement':
            case 'ForStatement':
            case 'IfStatement':
            case 'LabeledStatement':
            case 'ReturnStatement':
            case 'SwitchStatement':
            case 'ThrowStatement':
            case 'TryStatement':
            case 'VariableDeclaration':
            case 'WhileStatement':
            case 'WithStatement':
                return true;
        }
        return false;
    }

    function isSourceElement(node) {
      return isStatement(node) || node != null && node.type === 'FunctionDeclaration';
    }

    function trailingStatement(node) {
        switch (node.type) {
        case 'IfStatement':
            if (node.alternate != null) {
                return node.alternate;
            }
            return node.consequent;

        case 'LabeledStatement':
        case 'ForStatement':
        case 'ForInStatement':
        case 'WhileStatement':
        case 'WithStatement':
            return node.body;
        }
        return null;
    }

    function isProblematicIfStatement(node) {
        var current;

        if (node.type !== 'IfStatement') {
            return false;
        }
        if (node.alternate == null) {
            return false;
        }
        current = node.consequent;
        do {
            if (current.type === 'IfStatement') {
                if (current.alternate == null)  {
                    return true;
                }
            }
            current = trailingStatement(current);
        } while (current);

        return false;
    }

    module.exports = {
        isExpression: isExpression,
        isStatement: isStatement,
        isIterationStatement: isIterationStatement,
        isSourceElement: isSourceElement,
        isProblematicIfStatement: isProblematicIfStatement,

        trailingStatement: trailingStatement
    };
}());
/* vim: set sw=4 ts=4 et tw=80 : */

},{}],12:[function(require,module,exports){
/*
  Copyright (C) 2013 Yusuke Suzuki <utatane.tea@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

(function () {
    'use strict';

    var Regex;

    // See `tools/generate-identifier-regex.js`.
    Regex = {
        NonAsciiIdentifierStart: new RegExp('[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0\u08A2-\u08AC\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097F\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C33\u0C35-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F0\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191C\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA697\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA793\uA7A0-\uA7AA\uA7F8-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA80-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]'),
        NonAsciiIdentifierPart: new RegExp('[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u0527\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u08A0\u08A2-\u08AC\u08E4-\u08FE\u0900-\u0963\u0966-\u096F\u0971-\u0977\u0979-\u097F\u0981-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C01-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C33\u0C35-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58\u0C59\u0C60-\u0C63\u0C66-\u0C6F\u0C82\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D02\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D57\u0D60-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F0\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191C\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1CD0-\u1CD2\u1CD4-\u1CF6\u1D00-\u1DE6\u1DFC-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200C\u200D\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA697\uA69F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA793\uA7A0-\uA7AA\uA7F8-\uA827\uA840-\uA873\uA880-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A\uAA7B\uAA80-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uABC0-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE26\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]')
    };

    function isDecimalDigit(ch) {
        return (ch >= 48 && ch <= 57);   // 0..9
    }

    function isHexDigit(ch) {
        return isDecimalDigit(ch) || (97 <= ch && ch <= 102) || (65 <= ch && ch <= 70);
    }

    function isOctalDigit(ch) {
        return (ch >= 48 && ch <= 55);   // 0..7
    }

    // 7.2 White Space

    function isWhiteSpace(ch) {
        return (ch === 0x20) || (ch === 0x09) || (ch === 0x0B) || (ch === 0x0C) || (ch === 0xA0) ||
            (ch >= 0x1680 && [0x1680, 0x180E, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000, 0xFEFF].indexOf(ch) >= 0);
    }

    // 7.3 Line Terminators

    function isLineTerminator(ch) {
        return (ch === 0x0A) || (ch === 0x0D) || (ch === 0x2028) || (ch === 0x2029);
    }

    // 7.6 Identifier Names and Identifiers

    function isIdentifierStart(ch) {
        return (ch === 36) || (ch === 95) ||  // $ (dollar) and _ (underscore)
            (ch >= 65 && ch <= 90) ||         // A..Z
            (ch >= 97 && ch <= 122) ||        // a..z
            (ch === 92) ||                    // \ (backslash)
            ((ch >= 0x80) && Regex.NonAsciiIdentifierStart.test(String.fromCharCode(ch)));
    }

    function isIdentifierPart(ch) {
        return (ch === 36) || (ch === 95) ||  // $ (dollar) and _ (underscore)
            (ch >= 65 && ch <= 90) ||         // A..Z
            (ch >= 97 && ch <= 122) ||        // a..z
            (ch >= 48 && ch <= 57) ||         // 0..9
            (ch === 92) ||                    // \ (backslash)
            ((ch >= 0x80) && Regex.NonAsciiIdentifierPart.test(String.fromCharCode(ch)));
    }

    module.exports = {
        isDecimalDigit: isDecimalDigit,
        isHexDigit: isHexDigit,
        isOctalDigit: isOctalDigit,
        isWhiteSpace: isWhiteSpace,
        isLineTerminator: isLineTerminator,
        isIdentifierStart: isIdentifierStart,
        isIdentifierPart: isIdentifierPart
    };
}());
/* vim: set sw=4 ts=4 et tw=80 : */

},{}],13:[function(require,module,exports){
/*
  Copyright (C) 2013 Yusuke Suzuki <utatane.tea@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

(function () {
    'use strict';

    var code = require('./code');

    function isStrictModeReservedWordES6(id) {
        switch (id) {
        case 'implements':
        case 'interface':
        case 'package':
        case 'private':
        case 'protected':
        case 'public':
        case 'static':
        case 'let':
            return true;
        default:
            return false;
        }
    }

    function isKeywordES5(id, strict) {
        // yield should not be treated as keyword under non-strict mode.
        if (!strict && id === 'yield') {
            return false;
        }
        return isKeywordES6(id, strict);
    }

    function isKeywordES6(id, strict) {
        if (strict && isStrictModeReservedWordES6(id)) {
            return true;
        }

        switch (id.length) {
        case 2:
            return (id === 'if') || (id === 'in') || (id === 'do');
        case 3:
            return (id === 'var') || (id === 'for') || (id === 'new') || (id === 'try');
        case 4:
            return (id === 'this') || (id === 'else') || (id === 'case') ||
                (id === 'void') || (id === 'with') || (id === 'enum');
        case 5:
            return (id === 'while') || (id === 'break') || (id === 'catch') ||
                (id === 'throw') || (id === 'const') || (id === 'yield') ||
                (id === 'class') || (id === 'super');
        case 6:
            return (id === 'return') || (id === 'typeof') || (id === 'delete') ||
                (id === 'switch') || (id === 'export') || (id === 'import');
        case 7:
            return (id === 'default') || (id === 'finally') || (id === 'extends');
        case 8:
            return (id === 'function') || (id === 'continue') || (id === 'debugger');
        case 10:
            return (id === 'instanceof');
        default:
            return false;
        }
    }

    function isReservedWordES5(id, strict) {
        return id === 'null' || id === 'true' || id === 'false' || isKeywordES5(id, strict);
    }

    function isReservedWordES6(id, strict) {
        return id === 'null' || id === 'true' || id === 'false' || isKeywordES6(id, strict);
    }

    function isRestrictedWord(id) {
        return id === 'eval' || id === 'arguments';
    }

    function isIdentifierName(id) {
        var i, iz, ch;

        if (id.length === 0) {
            return false;
        }

        ch = id.charCodeAt(0);
        if (!code.isIdentifierStart(ch) || ch === 92) {  // \ (backslash)
            return false;
        }

        for (i = 1, iz = id.length; i < iz; ++i) {
            ch = id.charCodeAt(i);
            if (!code.isIdentifierPart(ch) || ch === 92) {  // \ (backslash)
                return false;
            }
        }
        return true;
    }

    function isIdentifierES5(id, strict) {
        return isIdentifierName(id) && !isReservedWordES5(id, strict);
    }

    function isIdentifierES6(id, strict) {
        return isIdentifierName(id) && !isReservedWordES6(id, strict);
    }

    module.exports = {
        isKeywordES5: isKeywordES5,
        isKeywordES6: isKeywordES6,
        isReservedWordES5: isReservedWordES5,
        isReservedWordES6: isReservedWordES6,
        isRestrictedWord: isRestrictedWord,
        isIdentifierName: isIdentifierName,
        isIdentifierES5: isIdentifierES5,
        isIdentifierES6: isIdentifierES6
    };
}());
/* vim: set sw=4 ts=4 et tw=80 : */

},{"./code":12}],14:[function(require,module,exports){
/*
  Copyright (C) 2013 Yusuke Suzuki <utatane.tea@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/


(function () {
    'use strict';

    exports.ast = require('./ast');
    exports.code = require('./code');
    exports.keyword = require('./keyword');
}());
/* vim: set sw=4 ts=4 et tw=80 : */

},{"./ast":11,"./code":12,"./keyword":13}],15:[function(require,module,exports){
/*
 * Copyright 2009-2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE.txt or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
exports.SourceMapGenerator = require('./source-map/source-map-generator').SourceMapGenerator;
exports.SourceMapConsumer = require('./source-map/source-map-consumer').SourceMapConsumer;
exports.SourceNode = require('./source-map/source-node').SourceNode;

},{"./source-map/source-map-consumer":20,"./source-map/source-map-generator":21,"./source-map/source-node":22}],16:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  var util = require('./util');

  /**
   * A data structure which is a combination of an array and a set. Adding a new
   * member is O(1), testing for membership is O(1), and finding the index of an
   * element is O(1). Removing elements from the set is not supported. Only
   * strings are supported for membership.
   */
  function ArraySet() {
    this._array = [];
    this._set = {};
  }

  /**
   * Static method for creating ArraySet instances from an existing array.
   */
  ArraySet.fromArray = function ArraySet_fromArray(aArray, aAllowDuplicates) {
    var set = new ArraySet();
    for (var i = 0, len = aArray.length; i < len; i++) {
      set.add(aArray[i], aAllowDuplicates);
    }
    return set;
  };

  /**
   * Add the given string to this set.
   *
   * @param String aStr
   */
  ArraySet.prototype.add = function ArraySet_add(aStr, aAllowDuplicates) {
    var isDuplicate = this.has(aStr);
    var idx = this._array.length;
    if (!isDuplicate || aAllowDuplicates) {
      this._array.push(aStr);
    }
    if (!isDuplicate) {
      this._set[util.toSetString(aStr)] = idx;
    }
  };

  /**
   * Is the given string a member of this set?
   *
   * @param String aStr
   */
  ArraySet.prototype.has = function ArraySet_has(aStr) {
    return Object.prototype.hasOwnProperty.call(this._set,
                                                util.toSetString(aStr));
  };

  /**
   * What is the index of the given string in the array?
   *
   * @param String aStr
   */
  ArraySet.prototype.indexOf = function ArraySet_indexOf(aStr) {
    if (this.has(aStr)) {
      return this._set[util.toSetString(aStr)];
    }
    throw new Error('"' + aStr + '" is not in the set.');
  };

  /**
   * What is the element at the given index?
   *
   * @param Number aIdx
   */
  ArraySet.prototype.at = function ArraySet_at(aIdx) {
    if (aIdx >= 0 && aIdx < this._array.length) {
      return this._array[aIdx];
    }
    throw new Error('No element indexed by ' + aIdx);
  };

  /**
   * Returns the array representation of this set (which has the proper indices
   * indicated by indexOf). Note that this is a copy of the internal array used
   * for storing the members so that no one can mess with internal state.
   */
  ArraySet.prototype.toArray = function ArraySet_toArray() {
    return this._array.slice();
  };

  exports.ArraySet = ArraySet;

});

},{"./util":23,"amdefine":24}],17:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 *
 * Based on the Base 64 VLQ implementation in Closure Compiler:
 * https://code.google.com/p/closure-compiler/source/browse/trunk/src/com/google/debugging/sourcemap/Base64VLQ.java
 *
 * Copyright 2011 The Closure Compiler Authors. All rights reserved.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *  * Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above
 *    copyright notice, this list of conditions and the following
 *    disclaimer in the documentation and/or other materials provided
 *    with the distribution.
 *  * Neither the name of Google Inc. nor the names of its
 *    contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  var base64 = require('./base64');

  // A single base 64 digit can contain 6 bits of data. For the base 64 variable
  // length quantities we use in the source map spec, the first bit is the sign,
  // the next four bits are the actual value, and the 6th bit is the
  // continuation bit. The continuation bit tells us whether there are more
  // digits in this value following this digit.
  //
  //   Continuation
  //   |    Sign
  //   |    |
  //   V    V
  //   101011

  var VLQ_BASE_SHIFT = 5;

  // binary: 100000
  var VLQ_BASE = 1 << VLQ_BASE_SHIFT;

  // binary: 011111
  var VLQ_BASE_MASK = VLQ_BASE - 1;

  // binary: 100000
  var VLQ_CONTINUATION_BIT = VLQ_BASE;

  /**
   * Converts from a two-complement value to a value where the sign bit is
   * is placed in the least significant bit.  For example, as decimals:
   *   1 becomes 2 (10 binary), -1 becomes 3 (11 binary)
   *   2 becomes 4 (100 binary), -2 becomes 5 (101 binary)
   */
  function toVLQSigned(aValue) {
    return aValue < 0
      ? ((-aValue) << 1) + 1
      : (aValue << 1) + 0;
  }

  /**
   * Converts to a two-complement value from a value where the sign bit is
   * is placed in the least significant bit.  For example, as decimals:
   *   2 (10 binary) becomes 1, 3 (11 binary) becomes -1
   *   4 (100 binary) becomes 2, 5 (101 binary) becomes -2
   */
  function fromVLQSigned(aValue) {
    var isNegative = (aValue & 1) === 1;
    var shifted = aValue >> 1;
    return isNegative
      ? -shifted
      : shifted;
  }

  /**
   * Returns the base 64 VLQ encoded value.
   */
  exports.encode = function base64VLQ_encode(aValue) {
    var encoded = "";
    var digit;

    var vlq = toVLQSigned(aValue);

    do {
      digit = vlq & VLQ_BASE_MASK;
      vlq >>>= VLQ_BASE_SHIFT;
      if (vlq > 0) {
        // There are still more digits in this value, so we must make sure the
        // continuation bit is marked.
        digit |= VLQ_CONTINUATION_BIT;
      }
      encoded += base64.encode(digit);
    } while (vlq > 0);

    return encoded;
  };

  /**
   * Decodes the next base 64 VLQ value from the given string and returns the
   * value and the rest of the string.
   */
  exports.decode = function base64VLQ_decode(aStr) {
    var i = 0;
    var strLen = aStr.length;
    var result = 0;
    var shift = 0;
    var continuation, digit;

    do {
      if (i >= strLen) {
        throw new Error("Expected more digits in base 64 VLQ value.");
      }
      digit = base64.decode(aStr.charAt(i++));
      continuation = !!(digit & VLQ_CONTINUATION_BIT);
      digit &= VLQ_BASE_MASK;
      result = result + (digit << shift);
      shift += VLQ_BASE_SHIFT;
    } while (continuation);

    return {
      value: fromVLQSigned(result),
      rest: aStr.slice(i)
    };
  };

});

},{"./base64":18,"amdefine":24}],18:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  var charToIntMap = {};
  var intToCharMap = {};

  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    .split('')
    .forEach(function (ch, index) {
      charToIntMap[ch] = index;
      intToCharMap[index] = ch;
    });

  /**
   * Encode an integer in the range of 0 to 63 to a single base 64 digit.
   */
  exports.encode = function base64_encode(aNumber) {
    if (aNumber in intToCharMap) {
      return intToCharMap[aNumber];
    }
    throw new TypeError("Must be between 0 and 63: " + aNumber);
  };

  /**
   * Decode a single base 64 digit to an integer.
   */
  exports.decode = function base64_decode(aChar) {
    if (aChar in charToIntMap) {
      return charToIntMap[aChar];
    }
    throw new TypeError("Not a valid base 64 digit: " + aChar);
  };

});

},{"amdefine":24}],19:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  /**
   * Recursive implementation of binary search.
   *
   * @param aLow Indices here and lower do not contain the needle.
   * @param aHigh Indices here and higher do not contain the needle.
   * @param aNeedle The element being searched for.
   * @param aHaystack The non-empty array being searched.
   * @param aCompare Function which takes two elements and returns -1, 0, or 1.
   */
  function recursiveSearch(aLow, aHigh, aNeedle, aHaystack, aCompare) {
    // This function terminates when one of the following is true:
    //
    //   1. We find the exact element we are looking for.
    //
    //   2. We did not find the exact element, but we can return the next
    //      closest element that is less than that element.
    //
    //   3. We did not find the exact element, and there is no next-closest
    //      element which is less than the one we are searching for, so we
    //      return null.
    var mid = Math.floor((aHigh - aLow) / 2) + aLow;
    var cmp = aCompare(aNeedle, aHaystack[mid], true);
    if (cmp === 0) {
      // Found the element we are looking for.
      return aHaystack[mid];
    }
    else if (cmp > 0) {
      // aHaystack[mid] is greater than our needle.
      if (aHigh - mid > 1) {
        // The element is in the upper half.
        return recursiveSearch(mid, aHigh, aNeedle, aHaystack, aCompare);
      }
      // We did not find an exact match, return the next closest one
      // (termination case 2).
      return aHaystack[mid];
    }
    else {
      // aHaystack[mid] is less than our needle.
      if (mid - aLow > 1) {
        // The element is in the lower half.
        return recursiveSearch(aLow, mid, aNeedle, aHaystack, aCompare);
      }
      // The exact needle element was not found in this haystack. Determine if
      // we are in termination case (2) or (3) and return the appropriate thing.
      return aLow < 0
        ? null
        : aHaystack[aLow];
    }
  }

  /**
   * This is an implementation of binary search which will always try and return
   * the next lowest value checked if there is no exact hit. This is because
   * mappings between original and generated line/col pairs are single points,
   * and there is an implicit region between each of them, so a miss just means
   * that you aren't on the very start of a region.
   *
   * @param aNeedle The element you are looking for.
   * @param aHaystack The array that is being searched.
   * @param aCompare A function which takes the needle and an element in the
   *     array and returns -1, 0, or 1 depending on whether the needle is less
   *     than, equal to, or greater than the element, respectively.
   */
  exports.search = function search(aNeedle, aHaystack, aCompare) {
    return aHaystack.length > 0
      ? recursiveSearch(-1, aHaystack.length, aNeedle, aHaystack, aCompare)
      : null;
  };

});

},{"amdefine":24}],20:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  var util = require('./util');
  var binarySearch = require('./binary-search');
  var ArraySet = require('./array-set').ArraySet;
  var base64VLQ = require('./base64-vlq');

  /**
   * A SourceMapConsumer instance represents a parsed source map which we can
   * query for information about the original file positions by giving it a file
   * position in the generated source.
   *
   * The only parameter is the raw source map (either as a JSON string, or
   * already parsed to an object). According to the spec, source maps have the
   * following attributes:
   *
   *   - version: Which version of the source map spec this map is following.
   *   - sources: An array of URLs to the original source files.
   *   - names: An array of identifiers which can be referrenced by individual mappings.
   *   - sourceRoot: Optional. The URL root from which all sources are relative.
   *   - sourcesContent: Optional. An array of contents of the original source files.
   *   - mappings: A string of base64 VLQs which contain the actual mappings.
   *   - file: Optional. The generated file this source map is associated with.
   *
   * Here is an example source map, taken from the source map spec[0]:
   *
   *     {
   *       version : 3,
   *       file: "out.js",
   *       sourceRoot : "",
   *       sources: ["foo.js", "bar.js"],
   *       names: ["src", "maps", "are", "fun"],
   *       mappings: "AA,AB;;ABCDE;"
   *     }
   *
   * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit?pli=1#
   */
  function SourceMapConsumer(aSourceMap) {
    var sourceMap = aSourceMap;
    if (typeof aSourceMap === 'string') {
      sourceMap = JSON.parse(aSourceMap.replace(/^\)\]\}'/, ''));
    }

    var version = util.getArg(sourceMap, 'version');
    var sources = util.getArg(sourceMap, 'sources');
    // Sass 3.3 leaves out the 'names' array, so we deviate from the spec (which
    // requires the array) to play nice here.
    var names = util.getArg(sourceMap, 'names', []);
    var sourceRoot = util.getArg(sourceMap, 'sourceRoot', null);
    var sourcesContent = util.getArg(sourceMap, 'sourcesContent', null);
    var mappings = util.getArg(sourceMap, 'mappings');
    var file = util.getArg(sourceMap, 'file', null);

    // Once again, Sass deviates from the spec and supplies the version as a
    // string rather than a number, so we use loose equality checking here.
    if (version != this._version) {
      throw new Error('Unsupported version: ' + version);
    }

    // Pass `true` below to allow duplicate names and sources. While source maps
    // are intended to be compressed and deduplicated, the TypeScript compiler
    // sometimes generates source maps with duplicates in them. See Github issue
    // #72 and bugzil.la/889492.
    this._names = ArraySet.fromArray(names, true);
    this._sources = ArraySet.fromArray(sources, true);

    this.sourceRoot = sourceRoot;
    this.sourcesContent = sourcesContent;
    this._mappings = mappings;
    this.file = file;
  }

  /**
   * Create a SourceMapConsumer from a SourceMapGenerator.
   *
   * @param SourceMapGenerator aSourceMap
   *        The source map that will be consumed.
   * @returns SourceMapConsumer
   */
  SourceMapConsumer.fromSourceMap =
    function SourceMapConsumer_fromSourceMap(aSourceMap) {
      var smc = Object.create(SourceMapConsumer.prototype);

      smc._names = ArraySet.fromArray(aSourceMap._names.toArray(), true);
      smc._sources = ArraySet.fromArray(aSourceMap._sources.toArray(), true);
      smc.sourceRoot = aSourceMap._sourceRoot;
      smc.sourcesContent = aSourceMap._generateSourcesContent(smc._sources.toArray(),
                                                              smc.sourceRoot);
      smc.file = aSourceMap._file;

      smc.__generatedMappings = aSourceMap._mappings.slice()
        .sort(util.compareByGeneratedPositions);
      smc.__originalMappings = aSourceMap._mappings.slice()
        .sort(util.compareByOriginalPositions);

      return smc;
    };

  /**
   * The version of the source mapping spec that we are consuming.
   */
  SourceMapConsumer.prototype._version = 3;

  /**
   * The list of original sources.
   */
  Object.defineProperty(SourceMapConsumer.prototype, 'sources', {
    get: function () {
      return this._sources.toArray().map(function (s) {
        return this.sourceRoot != null ? util.join(this.sourceRoot, s) : s;
      }, this);
    }
  });

  // `__generatedMappings` and `__originalMappings` are arrays that hold the
  // parsed mapping coordinates from the source map's "mappings" attribute. They
  // are lazily instantiated, accessed via the `_generatedMappings` and
  // `_originalMappings` getters respectively, and we only parse the mappings
  // and create these arrays once queried for a source location. We jump through
  // these hoops because there can be many thousands of mappings, and parsing
  // them is expensive, so we only want to do it if we must.
  //
  // Each object in the arrays is of the form:
  //
  //     {
  //       generatedLine: The line number in the generated code,
  //       generatedColumn: The column number in the generated code,
  //       source: The path to the original source file that generated this
  //               chunk of code,
  //       originalLine: The line number in the original source that
  //                     corresponds to this chunk of generated code,
  //       originalColumn: The column number in the original source that
  //                       corresponds to this chunk of generated code,
  //       name: The name of the original symbol which generated this chunk of
  //             code.
  //     }
  //
  // All properties except for `generatedLine` and `generatedColumn` can be
  // `null`.
  //
  // `_generatedMappings` is ordered by the generated positions.
  //
  // `_originalMappings` is ordered by the original positions.

  SourceMapConsumer.prototype.__generatedMappings = null;
  Object.defineProperty(SourceMapConsumer.prototype, '_generatedMappings', {
    get: function () {
      if (!this.__generatedMappings) {
        this.__generatedMappings = [];
        this.__originalMappings = [];
        this._parseMappings(this._mappings, this.sourceRoot);
      }

      return this.__generatedMappings;
    }
  });

  SourceMapConsumer.prototype.__originalMappings = null;
  Object.defineProperty(SourceMapConsumer.prototype, '_originalMappings', {
    get: function () {
      if (!this.__originalMappings) {
        this.__generatedMappings = [];
        this.__originalMappings = [];
        this._parseMappings(this._mappings, this.sourceRoot);
      }

      return this.__originalMappings;
    }
  });

  /**
   * Parse the mappings in a string in to a data structure which we can easily
   * query (the ordered arrays in the `this.__generatedMappings` and
   * `this.__originalMappings` properties).
   */
  SourceMapConsumer.prototype._parseMappings =
    function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
      var generatedLine = 1;
      var previousGeneratedColumn = 0;
      var previousOriginalLine = 0;
      var previousOriginalColumn = 0;
      var previousSource = 0;
      var previousName = 0;
      var mappingSeparator = /^[,;]/;
      var str = aStr;
      var mapping;
      var temp;

      while (str.length > 0) {
        if (str.charAt(0) === ';') {
          generatedLine++;
          str = str.slice(1);
          previousGeneratedColumn = 0;
        }
        else if (str.charAt(0) === ',') {
          str = str.slice(1);
        }
        else {
          mapping = {};
          mapping.generatedLine = generatedLine;

          // Generated column.
          temp = base64VLQ.decode(str);
          mapping.generatedColumn = previousGeneratedColumn + temp.value;
          previousGeneratedColumn = mapping.generatedColumn;
          str = temp.rest;

          if (str.length > 0 && !mappingSeparator.test(str.charAt(0))) {
            // Original source.
            temp = base64VLQ.decode(str);
            mapping.source = this._sources.at(previousSource + temp.value);
            previousSource += temp.value;
            str = temp.rest;
            if (str.length === 0 || mappingSeparator.test(str.charAt(0))) {
              throw new Error('Found a source, but no line and column');
            }

            // Original line.
            temp = base64VLQ.decode(str);
            mapping.originalLine = previousOriginalLine + temp.value;
            previousOriginalLine = mapping.originalLine;
            // Lines are stored 0-based
            mapping.originalLine += 1;
            str = temp.rest;
            if (str.length === 0 || mappingSeparator.test(str.charAt(0))) {
              throw new Error('Found a source and line, but no column');
            }

            // Original column.
            temp = base64VLQ.decode(str);
            mapping.originalColumn = previousOriginalColumn + temp.value;
            previousOriginalColumn = mapping.originalColumn;
            str = temp.rest;

            if (str.length > 0 && !mappingSeparator.test(str.charAt(0))) {
              // Original name.
              temp = base64VLQ.decode(str);
              mapping.name = this._names.at(previousName + temp.value);
              previousName += temp.value;
              str = temp.rest;
            }
          }

          this.__generatedMappings.push(mapping);
          if (typeof mapping.originalLine === 'number') {
            this.__originalMappings.push(mapping);
          }
        }
      }

      this.__generatedMappings.sort(util.compareByGeneratedPositions);
      this.__originalMappings.sort(util.compareByOriginalPositions);
    };

  /**
   * Find the mapping that best matches the hypothetical "needle" mapping that
   * we are searching for in the given "haystack" of mappings.
   */
  SourceMapConsumer.prototype._findMapping =
    function SourceMapConsumer_findMapping(aNeedle, aMappings, aLineName,
                                           aColumnName, aComparator) {
      // To return the position we are searching for, we must first find the
      // mapping for the given position and then return the opposite position it
      // points to. Because the mappings are sorted, we can use binary search to
      // find the best mapping.

      if (aNeedle[aLineName] <= 0) {
        throw new TypeError('Line must be greater than or equal to 1, got '
                            + aNeedle[aLineName]);
      }
      if (aNeedle[aColumnName] < 0) {
        throw new TypeError('Column must be greater than or equal to 0, got '
                            + aNeedle[aColumnName]);
      }

      return binarySearch.search(aNeedle, aMappings, aComparator);
    };

  /**
   * Returns the original source, line, and column information for the generated
   * source's line and column positions provided. The only argument is an object
   * with the following properties:
   *
   *   - line: The line number in the generated source.
   *   - column: The column number in the generated source.
   *
   * and an object is returned with the following properties:
   *
   *   - source: The original source file, or null.
   *   - line: The line number in the original source, or null.
   *   - column: The column number in the original source, or null.
   *   - name: The original identifier, or null.
   */
  SourceMapConsumer.prototype.originalPositionFor =
    function SourceMapConsumer_originalPositionFor(aArgs) {
      var needle = {
        generatedLine: util.getArg(aArgs, 'line'),
        generatedColumn: util.getArg(aArgs, 'column')
      };

      var mapping = this._findMapping(needle,
                                      this._generatedMappings,
                                      "generatedLine",
                                      "generatedColumn",
                                      util.compareByGeneratedPositions);

      if (mapping && mapping.generatedLine === needle.generatedLine) {
        var source = util.getArg(mapping, 'source', null);
        if (source != null && this.sourceRoot != null) {
          source = util.join(this.sourceRoot, source);
        }
        return {
          source: source,
          line: util.getArg(mapping, 'originalLine', null),
          column: util.getArg(mapping, 'originalColumn', null),
          name: util.getArg(mapping, 'name', null)
        };
      }

      return {
        source: null,
        line: null,
        column: null,
        name: null
      };
    };

  /**
   * Returns the original source content. The only argument is the url of the
   * original source file. Returns null if no original source content is
   * availible.
   */
  SourceMapConsumer.prototype.sourceContentFor =
    function SourceMapConsumer_sourceContentFor(aSource) {
      if (!this.sourcesContent) {
        return null;
      }

      if (this.sourceRoot != null) {
        aSource = util.relative(this.sourceRoot, aSource);
      }

      if (this._sources.has(aSource)) {
        return this.sourcesContent[this._sources.indexOf(aSource)];
      }

      var url;
      if (this.sourceRoot != null
          && (url = util.urlParse(this.sourceRoot))) {
        // XXX: file:// URIs and absolute paths lead to unexpected behavior for
        // many users. We can help them out when they expect file:// URIs to
        // behave like it would if they were running a local HTTP server. See
        // https://bugzilla.mozilla.org/show_bug.cgi?id=885597.
        var fileUriAbsPath = aSource.replace(/^file:\/\//, "");
        if (url.scheme == "file"
            && this._sources.has(fileUriAbsPath)) {
          return this.sourcesContent[this._sources.indexOf(fileUriAbsPath)]
        }

        if ((!url.path || url.path == "/")
            && this._sources.has("/" + aSource)) {
          return this.sourcesContent[this._sources.indexOf("/" + aSource)];
        }
      }

      throw new Error('"' + aSource + '" is not in the SourceMap.');
    };

  /**
   * Returns the generated line and column information for the original source,
   * line, and column positions provided. The only argument is an object with
   * the following properties:
   *
   *   - source: The filename of the original source.
   *   - line: The line number in the original source.
   *   - column: The column number in the original source.
   *
   * and an object is returned with the following properties:
   *
   *   - line: The line number in the generated source, or null.
   *   - column: The column number in the generated source, or null.
   */
  SourceMapConsumer.prototype.generatedPositionFor =
    function SourceMapConsumer_generatedPositionFor(aArgs) {
      var needle = {
        source: util.getArg(aArgs, 'source'),
        originalLine: util.getArg(aArgs, 'line'),
        originalColumn: util.getArg(aArgs, 'column')
      };

      if (this.sourceRoot != null) {
        needle.source = util.relative(this.sourceRoot, needle.source);
      }

      var mapping = this._findMapping(needle,
                                      this._originalMappings,
                                      "originalLine",
                                      "originalColumn",
                                      util.compareByOriginalPositions);

      if (mapping) {
        return {
          line: util.getArg(mapping, 'generatedLine', null),
          column: util.getArg(mapping, 'generatedColumn', null)
        };
      }

      return {
        line: null,
        column: null
      };
    };

  SourceMapConsumer.GENERATED_ORDER = 1;
  SourceMapConsumer.ORIGINAL_ORDER = 2;

  /**
   * Iterate over each mapping between an original source/line/column and a
   * generated line/column in this source map.
   *
   * @param Function aCallback
   *        The function that is called with each mapping.
   * @param Object aContext
   *        Optional. If specified, this object will be the value of `this` every
   *        time that `aCallback` is called.
   * @param aOrder
   *        Either `SourceMapConsumer.GENERATED_ORDER` or
   *        `SourceMapConsumer.ORIGINAL_ORDER`. Specifies whether you want to
   *        iterate over the mappings sorted by the generated file's line/column
   *        order or the original's source/line/column order, respectively. Defaults to
   *        `SourceMapConsumer.GENERATED_ORDER`.
   */
  SourceMapConsumer.prototype.eachMapping =
    function SourceMapConsumer_eachMapping(aCallback, aContext, aOrder) {
      var context = aContext || null;
      var order = aOrder || SourceMapConsumer.GENERATED_ORDER;

      var mappings;
      switch (order) {
      case SourceMapConsumer.GENERATED_ORDER:
        mappings = this._generatedMappings;
        break;
      case SourceMapConsumer.ORIGINAL_ORDER:
        mappings = this._originalMappings;
        break;
      default:
        throw new Error("Unknown order of iteration.");
      }

      var sourceRoot = this.sourceRoot;
      mappings.map(function (mapping) {
        var source = mapping.source;
        if (source != null && sourceRoot != null) {
          source = util.join(sourceRoot, source);
        }
        return {
          source: source,
          generatedLine: mapping.generatedLine,
          generatedColumn: mapping.generatedColumn,
          originalLine: mapping.originalLine,
          originalColumn: mapping.originalColumn,
          name: mapping.name
        };
      }).forEach(aCallback, context);
    };

  exports.SourceMapConsumer = SourceMapConsumer;

});

},{"./array-set":16,"./base64-vlq":17,"./binary-search":19,"./util":23,"amdefine":24}],21:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  var base64VLQ = require('./base64-vlq');
  var util = require('./util');
  var ArraySet = require('./array-set').ArraySet;

  /**
   * An instance of the SourceMapGenerator represents a source map which is
   * being built incrementally. You may pass an object with the following
   * properties:
   *
   *   - file: The filename of the generated source.
   *   - sourceRoot: A root for all relative URLs in this source map.
   */
  function SourceMapGenerator(aArgs) {
    if (!aArgs) {
      aArgs = {};
    }
    this._file = util.getArg(aArgs, 'file', null);
    this._sourceRoot = util.getArg(aArgs, 'sourceRoot', null);
    this._sources = new ArraySet();
    this._names = new ArraySet();
    this._mappings = [];
    this._sourcesContents = null;
  }

  SourceMapGenerator.prototype._version = 3;

  /**
   * Creates a new SourceMapGenerator based on a SourceMapConsumer
   *
   * @param aSourceMapConsumer The SourceMap.
   */
  SourceMapGenerator.fromSourceMap =
    function SourceMapGenerator_fromSourceMap(aSourceMapConsumer) {
      var sourceRoot = aSourceMapConsumer.sourceRoot;
      var generator = new SourceMapGenerator({
        file: aSourceMapConsumer.file,
        sourceRoot: sourceRoot
      });
      aSourceMapConsumer.eachMapping(function (mapping) {
        var newMapping = {
          generated: {
            line: mapping.generatedLine,
            column: mapping.generatedColumn
          }
        };

        if (mapping.source != null) {
          newMapping.source = mapping.source;
          if (sourceRoot != null) {
            newMapping.source = util.relative(sourceRoot, newMapping.source);
          }

          newMapping.original = {
            line: mapping.originalLine,
            column: mapping.originalColumn
          };

          if (mapping.name != null) {
            newMapping.name = mapping.name;
          }
        }

        generator.addMapping(newMapping);
      });
      aSourceMapConsumer.sources.forEach(function (sourceFile) {
        var content = aSourceMapConsumer.sourceContentFor(sourceFile);
        if (content != null) {
          generator.setSourceContent(sourceFile, content);
        }
      });
      return generator;
    };

  /**
   * Add a single mapping from original source line and column to the generated
   * source's line and column for this source map being created. The mapping
   * object should have the following properties:
   *
   *   - generated: An object with the generated line and column positions.
   *   - original: An object with the original line and column positions.
   *   - source: The original source file (relative to the sourceRoot).
   *   - name: An optional original token name for this mapping.
   */
  SourceMapGenerator.prototype.addMapping =
    function SourceMapGenerator_addMapping(aArgs) {
      var generated = util.getArg(aArgs, 'generated');
      var original = util.getArg(aArgs, 'original', null);
      var source = util.getArg(aArgs, 'source', null);
      var name = util.getArg(aArgs, 'name', null);

      this._validateMapping(generated, original, source, name);

      if (source != null && !this._sources.has(source)) {
        this._sources.add(source);
      }

      if (name != null && !this._names.has(name)) {
        this._names.add(name);
      }

      this._mappings.push({
        generatedLine: generated.line,
        generatedColumn: generated.column,
        originalLine: original != null && original.line,
        originalColumn: original != null && original.column,
        source: source,
        name: name
      });
    };

  /**
   * Set the source content for a source file.
   */
  SourceMapGenerator.prototype.setSourceContent =
    function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
      var source = aSourceFile;
      if (this._sourceRoot != null) {
        source = util.relative(this._sourceRoot, source);
      }

      if (aSourceContent != null) {
        // Add the source content to the _sourcesContents map.
        // Create a new _sourcesContents map if the property is null.
        if (!this._sourcesContents) {
          this._sourcesContents = {};
        }
        this._sourcesContents[util.toSetString(source)] = aSourceContent;
      } else if (this._sourcesContents) {
        // Remove the source file from the _sourcesContents map.
        // If the _sourcesContents map is empty, set the property to null.
        delete this._sourcesContents[util.toSetString(source)];
        if (Object.keys(this._sourcesContents).length === 0) {
          this._sourcesContents = null;
        }
      }
    };

  /**
   * Applies the mappings of a sub-source-map for a specific source file to the
   * source map being generated. Each mapping to the supplied source file is
   * rewritten using the supplied source map. Note: The resolution for the
   * resulting mappings is the minimium of this map and the supplied map.
   *
   * @param aSourceMapConsumer The source map to be applied.
   * @param aSourceFile Optional. The filename of the source file.
   *        If omitted, SourceMapConsumer's file property will be used.
   * @param aSourceMapPath Optional. The dirname of the path to the source map
   *        to be applied. If relative, it is relative to the SourceMapConsumer.
   *        This parameter is needed when the two source maps aren't in the same
   *        directory, and the source map to be applied contains relative source
   *        paths. If so, those relative source paths need to be rewritten
   *        relative to the SourceMapGenerator.
   */
  SourceMapGenerator.prototype.applySourceMap =
    function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
      var sourceFile = aSourceFile;
      // If aSourceFile is omitted, we will use the file property of the SourceMap
      if (aSourceFile == null) {
        if (aSourceMapConsumer.file == null) {
          throw new Error(
            'SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, ' +
            'or the source map\'s "file" property. Both were omitted.'
          );
        }
        sourceFile = aSourceMapConsumer.file;
      }
      var sourceRoot = this._sourceRoot;
      // Make "sourceFile" relative if an absolute Url is passed.
      if (sourceRoot != null) {
        sourceFile = util.relative(sourceRoot, sourceFile);
      }
      // Applying the SourceMap can add and remove items from the sources and
      // the names array.
      var newSources = new ArraySet();
      var newNames = new ArraySet();

      // Find mappings for the "sourceFile"
      this._mappings.forEach(function (mapping) {
        if (mapping.source === sourceFile && mapping.originalLine != null) {
          // Check if it can be mapped by the source map, then update the mapping.
          var original = aSourceMapConsumer.originalPositionFor({
            line: mapping.originalLine,
            column: mapping.originalColumn
          });
          if (original.source != null) {
            // Copy mapping
            mapping.source = original.source;
            if (aSourceMapPath != null) {
              mapping.source = util.join(aSourceMapPath, mapping.source)
            }
            if (sourceRoot != null) {
              mapping.source = util.relative(sourceRoot, mapping.source);
            }
            mapping.originalLine = original.line;
            mapping.originalColumn = original.column;
            if (original.name != null && mapping.name != null) {
              // Only use the identifier name if it's an identifier
              // in both SourceMaps
              mapping.name = original.name;
            }
          }
        }

        var source = mapping.source;
        if (source != null && !newSources.has(source)) {
          newSources.add(source);
        }

        var name = mapping.name;
        if (name != null && !newNames.has(name)) {
          newNames.add(name);
        }

      }, this);
      this._sources = newSources;
      this._names = newNames;

      // Copy sourcesContents of applied map.
      aSourceMapConsumer.sources.forEach(function (sourceFile) {
        var content = aSourceMapConsumer.sourceContentFor(sourceFile);
        if (content != null) {
          if (aSourceMapPath != null) {
            sourceFile = util.join(aSourceMapPath, sourceFile);
          }
          if (sourceRoot != null) {
            sourceFile = util.relative(sourceRoot, sourceFile);
          }
          this.setSourceContent(sourceFile, content);
        }
      }, this);
    };

  /**
   * A mapping can have one of the three levels of data:
   *
   *   1. Just the generated position.
   *   2. The Generated position, original position, and original source.
   *   3. Generated and original position, original source, as well as a name
   *      token.
   *
   * To maintain consistency, we validate that any new mapping being added falls
   * in to one of these categories.
   */
  SourceMapGenerator.prototype._validateMapping =
    function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource,
                                                aName) {
      if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
          && aGenerated.line > 0 && aGenerated.column >= 0
          && !aOriginal && !aSource && !aName) {
        // Case 1.
        return;
      }
      else if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
               && aOriginal && 'line' in aOriginal && 'column' in aOriginal
               && aGenerated.line > 0 && aGenerated.column >= 0
               && aOriginal.line > 0 && aOriginal.column >= 0
               && aSource) {
        // Cases 2 and 3.
        return;
      }
      else {
        throw new Error('Invalid mapping: ' + JSON.stringify({
          generated: aGenerated,
          source: aSource,
          original: aOriginal,
          name: aName
        }));
      }
    };

  /**
   * Serialize the accumulated mappings in to the stream of base 64 VLQs
   * specified by the source map format.
   */
  SourceMapGenerator.prototype._serializeMappings =
    function SourceMapGenerator_serializeMappings() {
      var previousGeneratedColumn = 0;
      var previousGeneratedLine = 1;
      var previousOriginalColumn = 0;
      var previousOriginalLine = 0;
      var previousName = 0;
      var previousSource = 0;
      var result = '';
      var mapping;

      // The mappings must be guaranteed to be in sorted order before we start
      // serializing them or else the generated line numbers (which are defined
      // via the ';' separators) will be all messed up. Note: it might be more
      // performant to maintain the sorting as we insert them, rather than as we
      // serialize them, but the big O is the same either way.
      this._mappings.sort(util.compareByGeneratedPositions);

      for (var i = 0, len = this._mappings.length; i < len; i++) {
        mapping = this._mappings[i];

        if (mapping.generatedLine !== previousGeneratedLine) {
          previousGeneratedColumn = 0;
          while (mapping.generatedLine !== previousGeneratedLine) {
            result += ';';
            previousGeneratedLine++;
          }
        }
        else {
          if (i > 0) {
            if (!util.compareByGeneratedPositions(mapping, this._mappings[i - 1])) {
              continue;
            }
            result += ',';
          }
        }

        result += base64VLQ.encode(mapping.generatedColumn
                                   - previousGeneratedColumn);
        previousGeneratedColumn = mapping.generatedColumn;

        if (mapping.source != null) {
          result += base64VLQ.encode(this._sources.indexOf(mapping.source)
                                     - previousSource);
          previousSource = this._sources.indexOf(mapping.source);

          // lines are stored 0-based in SourceMap spec version 3
          result += base64VLQ.encode(mapping.originalLine - 1
                                     - previousOriginalLine);
          previousOriginalLine = mapping.originalLine - 1;

          result += base64VLQ.encode(mapping.originalColumn
                                     - previousOriginalColumn);
          previousOriginalColumn = mapping.originalColumn;

          if (mapping.name != null) {
            result += base64VLQ.encode(this._names.indexOf(mapping.name)
                                       - previousName);
            previousName = this._names.indexOf(mapping.name);
          }
        }
      }

      return result;
    };

  SourceMapGenerator.prototype._generateSourcesContent =
    function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
      return aSources.map(function (source) {
        if (!this._sourcesContents) {
          return null;
        }
        if (aSourceRoot != null) {
          source = util.relative(aSourceRoot, source);
        }
        var key = util.toSetString(source);
        return Object.prototype.hasOwnProperty.call(this._sourcesContents,
                                                    key)
          ? this._sourcesContents[key]
          : null;
      }, this);
    };

  /**
   * Externalize the source map.
   */
  SourceMapGenerator.prototype.toJSON =
    function SourceMapGenerator_toJSON() {
      var map = {
        version: this._version,
        sources: this._sources.toArray(),
        names: this._names.toArray(),
        mappings: this._serializeMappings()
      };
      if (this._file != null) {
        map.file = this._file;
      }
      if (this._sourceRoot != null) {
        map.sourceRoot = this._sourceRoot;
      }
      if (this._sourcesContents) {
        map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
      }

      return map;
    };

  /**
   * Render the source map being generated to a string.
   */
  SourceMapGenerator.prototype.toString =
    function SourceMapGenerator_toString() {
      return JSON.stringify(this);
    };

  exports.SourceMapGenerator = SourceMapGenerator;

});

},{"./array-set":16,"./base64-vlq":17,"./util":23,"amdefine":24}],22:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  var SourceMapGenerator = require('./source-map-generator').SourceMapGenerator;
  var util = require('./util');

  // Matches a Windows-style `\r\n` newline or a `\n` newline used by all other
  // operating systems these days (capturing the result).
  var REGEX_NEWLINE = /(\r?\n)/;

  // Matches a Windows-style newline, or any character.
  var REGEX_CHARACTER = /\r\n|[\s\S]/g;

  /**
   * SourceNodes provide a way to abstract over interpolating/concatenating
   * snippets of generated JavaScript source code while maintaining the line and
   * column information associated with the original source code.
   *
   * @param aLine The original line number.
   * @param aColumn The original column number.
   * @param aSource The original source's filename.
   * @param aChunks Optional. An array of strings which are snippets of
   *        generated JS, or other SourceNodes.
   * @param aName The original identifier.
   */
  function SourceNode(aLine, aColumn, aSource, aChunks, aName) {
    this.children = [];
    this.sourceContents = {};
    this.line = aLine == null ? null : aLine;
    this.column = aColumn == null ? null : aColumn;
    this.source = aSource == null ? null : aSource;
    this.name = aName == null ? null : aName;
    if (aChunks != null) this.add(aChunks);
  }

  /**
   * Creates a SourceNode from generated code and a SourceMapConsumer.
   *
   * @param aGeneratedCode The generated code
   * @param aSourceMapConsumer The SourceMap for the generated code
   * @param aRelativePath Optional. The path that relative sources in the
   *        SourceMapConsumer should be relative to.
   */
  SourceNode.fromStringWithSourceMap =
    function SourceNode_fromStringWithSourceMap(aGeneratedCode, aSourceMapConsumer, aRelativePath) {
      // The SourceNode we want to fill with the generated code
      // and the SourceMap
      var node = new SourceNode();

      // All even indices of this array are one line of the generated code,
      // while all odd indices are the newlines between two adjacent lines
      // (since `REGEX_NEWLINE` captures its match).
      // Processed fragments are removed from this array, by calling `shiftNextLine`.
      var remainingLines = aGeneratedCode.split(REGEX_NEWLINE);
      var shiftNextLine = function() {
        var lineContents = remainingLines.shift();
        // The last line of a file might not have a newline.
        var newLine = remainingLines.shift() || "";
        return lineContents + newLine;
      };

      // We need to remember the position of "remainingLines"
      var lastGeneratedLine = 1, lastGeneratedColumn = 0;

      // The generate SourceNodes we need a code range.
      // To extract it current and last mapping is used.
      // Here we store the last mapping.
      var lastMapping = null;

      aSourceMapConsumer.eachMapping(function (mapping) {
        if (lastMapping !== null) {
          // We add the code from "lastMapping" to "mapping":
          // First check if there is a new line in between.
          if (lastGeneratedLine < mapping.generatedLine) {
            var code = "";
            // Associate first line with "lastMapping"
            addMappingWithCode(lastMapping, shiftNextLine());
            lastGeneratedLine++;
            lastGeneratedColumn = 0;
            // The remaining code is added without mapping
          } else {
            // There is no new line in between.
            // Associate the code between "lastGeneratedColumn" and
            // "mapping.generatedColumn" with "lastMapping"
            var nextLine = remainingLines[0];
            var code = nextLine.substr(0, mapping.generatedColumn -
                                          lastGeneratedColumn);
            remainingLines[0] = nextLine.substr(mapping.generatedColumn -
                                                lastGeneratedColumn);
            lastGeneratedColumn = mapping.generatedColumn;
            addMappingWithCode(lastMapping, code);
            // No more remaining code, continue
            lastMapping = mapping;
            return;
          }
        }
        // We add the generated code until the first mapping
        // to the SourceNode without any mapping.
        // Each line is added as separate string.
        while (lastGeneratedLine < mapping.generatedLine) {
          node.add(shiftNextLine());
          lastGeneratedLine++;
        }
        if (lastGeneratedColumn < mapping.generatedColumn) {
          var nextLine = remainingLines[0];
          node.add(nextLine.substr(0, mapping.generatedColumn));
          remainingLines[0] = nextLine.substr(mapping.generatedColumn);
          lastGeneratedColumn = mapping.generatedColumn;
        }
        lastMapping = mapping;
      }, this);
      // We have processed all mappings.
      if (remainingLines.length > 0) {
        if (lastMapping) {
          // Associate the remaining code in the current line with "lastMapping"
          addMappingWithCode(lastMapping, shiftNextLine());
        }
        // and add the remaining lines without any mapping
        node.add(remainingLines.join(""));
      }

      // Copy sourcesContent into SourceNode
      aSourceMapConsumer.sources.forEach(function (sourceFile) {
        var content = aSourceMapConsumer.sourceContentFor(sourceFile);
        if (content != null) {
          if (aRelativePath != null) {
            sourceFile = util.join(aRelativePath, sourceFile);
          }
          node.setSourceContent(sourceFile, content);
        }
      });

      return node;

      function addMappingWithCode(mapping, code) {
        if (mapping === null || mapping.source === undefined) {
          node.add(code);
        } else {
          var source = aRelativePath
            ? util.join(aRelativePath, mapping.source)
            : mapping.source;
          node.add(new SourceNode(mapping.originalLine,
                                  mapping.originalColumn,
                                  source,
                                  code,
                                  mapping.name));
        }
      }
    };

  /**
   * Add a chunk of generated JS to this source node.
   *
   * @param aChunk A string snippet of generated JS code, another instance of
   *        SourceNode, or an array where each member is one of those things.
   */
  SourceNode.prototype.add = function SourceNode_add(aChunk) {
    if (Array.isArray(aChunk)) {
      aChunk.forEach(function (chunk) {
        this.add(chunk);
      }, this);
    }
    else if (aChunk instanceof SourceNode || typeof aChunk === "string") {
      if (aChunk) {
        this.children.push(aChunk);
      }
    }
    else {
      throw new TypeError(
        "Expected a SourceNode, string, or an array of SourceNodes and strings. Got " + aChunk
      );
    }
    return this;
  };

  /**
   * Add a chunk of generated JS to the beginning of this source node.
   *
   * @param aChunk A string snippet of generated JS code, another instance of
   *        SourceNode, or an array where each member is one of those things.
   */
  SourceNode.prototype.prepend = function SourceNode_prepend(aChunk) {
    if (Array.isArray(aChunk)) {
      for (var i = aChunk.length-1; i >= 0; i--) {
        this.prepend(aChunk[i]);
      }
    }
    else if (aChunk instanceof SourceNode || typeof aChunk === "string") {
      this.children.unshift(aChunk);
    }
    else {
      throw new TypeError(
        "Expected a SourceNode, string, or an array of SourceNodes and strings. Got " + aChunk
      );
    }
    return this;
  };

  /**
   * Walk over the tree of JS snippets in this node and its children. The
   * walking function is called once for each snippet of JS and is passed that
   * snippet and the its original associated source's line/column location.
   *
   * @param aFn The traversal function.
   */
  SourceNode.prototype.walk = function SourceNode_walk(aFn) {
    var chunk;
    for (var i = 0, len = this.children.length; i < len; i++) {
      chunk = this.children[i];
      if (chunk instanceof SourceNode) {
        chunk.walk(aFn);
      }
      else {
        if (chunk !== '') {
          aFn(chunk, { source: this.source,
                       line: this.line,
                       column: this.column,
                       name: this.name });
        }
      }
    }
  };

  /**
   * Like `String.prototype.join` except for SourceNodes. Inserts `aStr` between
   * each of `this.children`.
   *
   * @param aSep The separator.
   */
  SourceNode.prototype.join = function SourceNode_join(aSep) {
    var newChildren;
    var i;
    var len = this.children.length;
    if (len > 0) {
      newChildren = [];
      for (i = 0; i < len-1; i++) {
        newChildren.push(this.children[i]);
        newChildren.push(aSep);
      }
      newChildren.push(this.children[i]);
      this.children = newChildren;
    }
    return this;
  };

  /**
   * Call String.prototype.replace on the very right-most source snippet. Useful
   * for trimming whitespace from the end of a source node, etc.
   *
   * @param aPattern The pattern to replace.
   * @param aReplacement The thing to replace the pattern with.
   */
  SourceNode.prototype.replaceRight = function SourceNode_replaceRight(aPattern, aReplacement) {
    var lastChild = this.children[this.children.length - 1];
    if (lastChild instanceof SourceNode) {
      lastChild.replaceRight(aPattern, aReplacement);
    }
    else if (typeof lastChild === 'string') {
      this.children[this.children.length - 1] = lastChild.replace(aPattern, aReplacement);
    }
    else {
      this.children.push(''.replace(aPattern, aReplacement));
    }
    return this;
  };

  /**
   * Set the source content for a source file. This will be added to the SourceMapGenerator
   * in the sourcesContent field.
   *
   * @param aSourceFile The filename of the source file
   * @param aSourceContent The content of the source file
   */
  SourceNode.prototype.setSourceContent =
    function SourceNode_setSourceContent(aSourceFile, aSourceContent) {
      this.sourceContents[util.toSetString(aSourceFile)] = aSourceContent;
    };

  /**
   * Walk over the tree of SourceNodes. The walking function is called for each
   * source file content and is passed the filename and source content.
   *
   * @param aFn The traversal function.
   */
  SourceNode.prototype.walkSourceContents =
    function SourceNode_walkSourceContents(aFn) {
      for (var i = 0, len = this.children.length; i < len; i++) {
        if (this.children[i] instanceof SourceNode) {
          this.children[i].walkSourceContents(aFn);
        }
      }

      var sources = Object.keys(this.sourceContents);
      for (var i = 0, len = sources.length; i < len; i++) {
        aFn(util.fromSetString(sources[i]), this.sourceContents[sources[i]]);
      }
    };

  /**
   * Return the string representation of this source node. Walks over the tree
   * and concatenates all the various snippets together to one string.
   */
  SourceNode.prototype.toString = function SourceNode_toString() {
    var str = "";
    this.walk(function (chunk) {
      str += chunk;
    });
    return str;
  };

  /**
   * Returns the string representation of this source node along with a source
   * map.
   */
  SourceNode.prototype.toStringWithSourceMap = function SourceNode_toStringWithSourceMap(aArgs) {
    var generated = {
      code: "",
      line: 1,
      column: 0
    };
    var map = new SourceMapGenerator(aArgs);
    var sourceMappingActive = false;
    var lastOriginalSource = null;
    var lastOriginalLine = null;
    var lastOriginalColumn = null;
    var lastOriginalName = null;
    this.walk(function (chunk, original) {
      generated.code += chunk;
      if (original.source !== null
          && original.line !== null
          && original.column !== null) {
        if(lastOriginalSource !== original.source
           || lastOriginalLine !== original.line
           || lastOriginalColumn !== original.column
           || lastOriginalName !== original.name) {
          map.addMapping({
            source: original.source,
            original: {
              line: original.line,
              column: original.column
            },
            generated: {
              line: generated.line,
              column: generated.column
            },
            name: original.name
          });
        }
        lastOriginalSource = original.source;
        lastOriginalLine = original.line;
        lastOriginalColumn = original.column;
        lastOriginalName = original.name;
        sourceMappingActive = true;
      } else if (sourceMappingActive) {
        map.addMapping({
          generated: {
            line: generated.line,
            column: generated.column
          }
        });
        lastOriginalSource = null;
        sourceMappingActive = false;
      }
      chunk.match(REGEX_CHARACTER).forEach(function (ch, idx, array) {
        if (REGEX_NEWLINE.test(ch)) {
          generated.line++;
          generated.column = 0;
          // Mappings end at eol
          if (idx + 1 === array.length) {
            lastOriginalSource = null;
            sourceMappingActive = false;
          } else if (sourceMappingActive) {
            map.addMapping({
              source: original.source,
              original: {
                line: original.line,
                column: original.column
              },
              generated: {
                line: generated.line,
                column: generated.column
              },
              name: original.name
            });
          }
        } else {
          generated.column += ch.length;
        }
      });
    });
    this.walkSourceContents(function (sourceFile, sourceContent) {
      map.setSourceContent(sourceFile, sourceContent);
    });

    return { code: generated.code, map: map };
  };

  exports.SourceNode = SourceNode;

});

},{"./source-map-generator":21,"./util":23,"amdefine":24}],23:[function(require,module,exports){
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
if (typeof define !== 'function') {
    var define = require('amdefine')(module, require);
}
define(function (require, exports, module) {

  /**
   * This is a helper function for getting values from parameter/options
   * objects.
   *
   * @param args The object we are extracting values from
   * @param name The name of the property we are getting.
   * @param defaultValue An optional value to return if the property is missing
   * from the object. If this is not specified and the property is missing, an
   * error will be thrown.
   */
  function getArg(aArgs, aName, aDefaultValue) {
    if (aName in aArgs) {
      return aArgs[aName];
    } else if (arguments.length === 3) {
      return aDefaultValue;
    } else {
      throw new Error('"' + aName + '" is a required argument.');
    }
  }
  exports.getArg = getArg;

  var urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.]*)(?::(\d+))?(\S*)$/;
  var dataUrlRegexp = /^data:.+\,.+$/;

  function urlParse(aUrl) {
    var match = aUrl.match(urlRegexp);
    if (!match) {
      return null;
    }
    return {
      scheme: match[1],
      auth: match[2],
      host: match[3],
      port: match[4],
      path: match[5]
    };
  }
  exports.urlParse = urlParse;

  function urlGenerate(aParsedUrl) {
    var url = '';
    if (aParsedUrl.scheme) {
      url += aParsedUrl.scheme + ':';
    }
    url += '//';
    if (aParsedUrl.auth) {
      url += aParsedUrl.auth + '@';
    }
    if (aParsedUrl.host) {
      url += aParsedUrl.host;
    }
    if (aParsedUrl.port) {
      url += ":" + aParsedUrl.port
    }
    if (aParsedUrl.path) {
      url += aParsedUrl.path;
    }
    return url;
  }
  exports.urlGenerate = urlGenerate;

  /**
   * Normalizes a path, or the path portion of a URL:
   *
   * - Replaces consequtive slashes with one slash.
   * - Removes unnecessary '.' parts.
   * - Removes unnecessary '<dir>/..' parts.
   *
   * Based on code in the Node.js 'path' core module.
   *
   * @param aPath The path or url to normalize.
   */
  function normalize(aPath) {
    var path = aPath;
    var url = urlParse(aPath);
    if (url) {
      if (!url.path) {
        return aPath;
      }
      path = url.path;
    }
    var isAbsolute = (path.charAt(0) === '/');

    var parts = path.split(/\/+/);
    for (var part, up = 0, i = parts.length - 1; i >= 0; i--) {
      part = parts[i];
      if (part === '.') {
        parts.splice(i, 1);
      } else if (part === '..') {
        up++;
      } else if (up > 0) {
        if (part === '') {
          // The first part is blank if the path is absolute. Trying to go
          // above the root is a no-op. Therefore we can remove all '..' parts
          // directly after the root.
          parts.splice(i + 1, up);
          up = 0;
        } else {
          parts.splice(i, 2);
          up--;
        }
      }
    }
    path = parts.join('/');

    if (path === '') {
      path = isAbsolute ? '/' : '.';
    }

    if (url) {
      url.path = path;
      return urlGenerate(url);
    }
    return path;
  }
  exports.normalize = normalize;

  /**
   * Joins two paths/URLs.
   *
   * @param aRoot The root path or URL.
   * @param aPath The path or URL to be joined with the root.
   *
   * - If aPath is a URL or a data URI, aPath is returned, unless aPath is a
   *   scheme-relative URL: Then the scheme of aRoot, if any, is prepended
   *   first.
   * - Otherwise aPath is a path. If aRoot is a URL, then its path portion
   *   is updated with the result and aRoot is returned. Otherwise the result
   *   is returned.
   *   - If aPath is absolute, the result is aPath.
   *   - Otherwise the two paths are joined with a slash.
   * - Joining for example 'http://' and 'www.example.com' is also supported.
   */
  function join(aRoot, aPath) {
    if (aRoot === "") {
      aRoot = ".";
    }
    if (aPath === "") {
      aPath = ".";
    }
    var aPathUrl = urlParse(aPath);
    var aRootUrl = urlParse(aRoot);
    if (aRootUrl) {
      aRoot = aRootUrl.path || '/';
    }

    // `join(foo, '//www.example.org')`
    if (aPathUrl && !aPathUrl.scheme) {
      if (aRootUrl) {
        aPathUrl.scheme = aRootUrl.scheme;
      }
      return urlGenerate(aPathUrl);
    }

    if (aPathUrl || aPath.match(dataUrlRegexp)) {
      return aPath;
    }

    // `join('http://', 'www.example.com')`
    if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
      aRootUrl.host = aPath;
      return urlGenerate(aRootUrl);
    }

    var joined = aPath.charAt(0) === '/'
      ? aPath
      : normalize(aRoot.replace(/\/+$/, '') + '/' + aPath);

    if (aRootUrl) {
      aRootUrl.path = joined;
      return urlGenerate(aRootUrl);
    }
    return joined;
  }
  exports.join = join;

  /**
   * Make a path relative to a URL or another path.
   *
   * @param aRoot The root path or URL.
   * @param aPath The path or URL to be made relative to aRoot.
   */
  function relative(aRoot, aPath) {
    if (aRoot === "") {
      aRoot = ".";
    }

    aRoot = aRoot.replace(/\/$/, '');

    // XXX: It is possible to remove this block, and the tests still pass!
    var url = urlParse(aRoot);
    if (aPath.charAt(0) == "/" && url && url.path == "/") {
      return aPath.slice(1);
    }

    return aPath.indexOf(aRoot + '/') === 0
      ? aPath.substr(aRoot.length + 1)
      : aPath;
  }
  exports.relative = relative;

  /**
   * Because behavior goes wacky when you set `__proto__` on objects, we
   * have to prefix all the strings in our set with an arbitrary character.
   *
   * See https://github.com/mozilla/source-map/pull/31 and
   * https://github.com/mozilla/source-map/issues/30
   *
   * @param String aStr
   */
  function toSetString(aStr) {
    return '$' + aStr;
  }
  exports.toSetString = toSetString;

  function fromSetString(aStr) {
    return aStr.substr(1);
  }
  exports.fromSetString = fromSetString;

  function strcmp(aStr1, aStr2) {
    var s1 = aStr1 || "";
    var s2 = aStr2 || "";
    return (s1 > s2) - (s1 < s2);
  }

  /**
   * Comparator between two mappings where the original positions are compared.
   *
   * Optionally pass in `true` as `onlyCompareGenerated` to consider two
   * mappings with the same original source/line/column, but different generated
   * line and column the same. Useful when searching for a mapping with a
   * stubbed out mapping.
   */
  function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
    var cmp;

    cmp = strcmp(mappingA.source, mappingB.source);
    if (cmp) {
      return cmp;
    }

    cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp) {
      return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp || onlyCompareOriginal) {
      return cmp;
    }

    cmp = strcmp(mappingA.name, mappingB.name);
    if (cmp) {
      return cmp;
    }

    cmp = mappingA.generatedLine - mappingB.generatedLine;
    if (cmp) {
      return cmp;
    }

    return mappingA.generatedColumn - mappingB.generatedColumn;
  };
  exports.compareByOriginalPositions = compareByOriginalPositions;

  /**
   * Comparator between two mappings where the generated positions are
   * compared.
   *
   * Optionally pass in `true` as `onlyCompareGenerated` to consider two
   * mappings with the same generated line and column, but different
   * source/name/original line and column the same. Useful when searching for a
   * mapping with a stubbed out mapping.
   */
  function compareByGeneratedPositions(mappingA, mappingB, onlyCompareGenerated) {
    var cmp;

    cmp = mappingA.generatedLine - mappingB.generatedLine;
    if (cmp) {
      return cmp;
    }

    cmp = mappingA.generatedColumn - mappingB.generatedColumn;
    if (cmp || onlyCompareGenerated) {
      return cmp;
    }

    cmp = strcmp(mappingA.source, mappingB.source);
    if (cmp) {
      return cmp;
    }

    cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp) {
      return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp) {
      return cmp;
    }

    return strcmp(mappingA.name, mappingB.name);
  };
  exports.compareByGeneratedPositions = compareByGeneratedPositions;

});

},{"amdefine":24}],24:[function(require,module,exports){
(function (process,__filename){
/** vim: et:ts=4:sw=4:sts=4
 * @license amdefine 0.1.0 Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/amdefine for details
 */

/*jslint node: true */
/*global module, process */
'use strict';

/**
 * Creates a define for node.
 * @param {Object} module the "module" object that is defined by Node for the
 * current module.
 * @param {Function} [requireFn]. Node's require function for the current module.
 * It only needs to be passed in Node versions before 0.5, when module.require
 * did not exist.
 * @returns {Function} a define function that is usable for the current node
 * module.
 */
function amdefine(module, requireFn) {
    'use strict';
    var defineCache = {},
        loaderCache = {},
        alreadyCalled = false,
        path = require('path'),
        makeRequire, stringRequire;

    /**
     * Trims the . and .. from an array of path segments.
     * It will keep a leading path segment if a .. will become
     * the first path segment, to help with module name lookups,
     * which act like paths, but can be remapped. But the end result,
     * all paths that use this function should look normalized.
     * NOTE: this method MODIFIES the input array.
     * @param {Array} ary the array of path segments.
     */
    function trimDots(ary) {
        var i, part;
        for (i = 0; ary[i]; i+= 1) {
            part = ary[i];
            if (part === '.') {
                ary.splice(i, 1);
                i -= 1;
            } else if (part === '..') {
                if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
                    //End of the line. Keep at least one non-dot
                    //path segment at the front so it can be mapped
                    //correctly to disk. Otherwise, there is likely
                    //no path mapping for a path starting with '..'.
                    //This can still fail, but catches the most reasonable
                    //uses of ..
                    break;
                } else if (i > 0) {
                    ary.splice(i - 1, 2);
                    i -= 2;
                }
            }
        }
    }

    function normalize(name, baseName) {
        var baseParts;

        //Adjust any relative paths.
        if (name && name.charAt(0) === '.') {
            //If have a base name, try to normalize against it,
            //otherwise, assume it is a top-level require that will
            //be relative to baseUrl in the end.
            if (baseName) {
                baseParts = baseName.split('/');
                baseParts = baseParts.slice(0, baseParts.length - 1);
                baseParts = baseParts.concat(name.split('/'));
                trimDots(baseParts);
                name = baseParts.join('/');
            }
        }

        return name;
    }

    /**
     * Create the normalize() function passed to a loader plugin's
     * normalize method.
     */
    function makeNormalize(relName) {
        return function (name) {
            return normalize(name, relName);
        };
    }

    function makeLoad(id) {
        function load(value) {
            loaderCache[id] = value;
        }

        load.fromText = function (id, text) {
            //This one is difficult because the text can/probably uses
            //define, and any relative paths and requires should be relative
            //to that id was it would be found on disk. But this would require
            //bootstrapping a module/require fairly deeply from node core.
            //Not sure how best to go about that yet.
            throw new Error('amdefine does not implement load.fromText');
        };

        return load;
    }

    makeRequire = function (systemRequire, exports, module, relId) {
        function amdRequire(deps, callback) {
            if (typeof deps === 'string') {
                //Synchronous, single module require('')
                return stringRequire(systemRequire, exports, module, deps, relId);
            } else {
                //Array of dependencies with a callback.

                //Convert the dependencies to modules.
                deps = deps.map(function (depName) {
                    return stringRequire(systemRequire, exports, module, depName, relId);
                });

                //Wait for next tick to call back the require call.
                process.nextTick(function () {
                    callback.apply(null, deps);
                });
            }
        }

        amdRequire.toUrl = function (filePath) {
            if (filePath.indexOf('.') === 0) {
                return normalize(filePath, path.dirname(module.filename));
            } else {
                return filePath;
            }
        };

        return amdRequire;
    };

    //Favor explicit value, passed in if the module wants to support Node 0.4.
    requireFn = requireFn || function req() {
        return module.require.apply(module, arguments);
    };

    function runFactory(id, deps, factory) {
        var r, e, m, result;

        if (id) {
            e = loaderCache[id] = {};
            m = {
                id: id,
                uri: __filename,
                exports: e
            };
            r = makeRequire(requireFn, e, m, id);
        } else {
            //Only support one define call per file
            if (alreadyCalled) {
                throw new Error('amdefine with no module ID cannot be called more than once per file.');
            }
            alreadyCalled = true;

            //Use the real variables from node
            //Use module.exports for exports, since
            //the exports in here is amdefine exports.
            e = module.exports;
            m = module;
            r = makeRequire(requireFn, e, m, module.id);
        }

        //If there are dependencies, they are strings, so need
        //to convert them to dependency values.
        if (deps) {
            deps = deps.map(function (depName) {
                return r(depName);
            });
        }

        //Call the factory with the right dependencies.
        if (typeof factory === 'function') {
            result = factory.apply(m.exports, deps);
        } else {
            result = factory;
        }

        if (result !== undefined) {
            m.exports = result;
            if (id) {
                loaderCache[id] = m.exports;
            }
        }
    }

    stringRequire = function (systemRequire, exports, module, id, relId) {
        //Split the ID by a ! so that
        var index = id.indexOf('!'),
            originalId = id,
            prefix, plugin;

        if (index === -1) {
            id = normalize(id, relId);

            //Straight module lookup. If it is one of the special dependencies,
            //deal with it, otherwise, delegate to node.
            if (id === 'require') {
                return makeRequire(systemRequire, exports, module, relId);
            } else if (id === 'exports') {
                return exports;
            } else if (id === 'module') {
                return module;
            } else if (loaderCache.hasOwnProperty(id)) {
                return loaderCache[id];
            } else if (defineCache[id]) {
                runFactory.apply(null, defineCache[id]);
                return loaderCache[id];
            } else {
                if(systemRequire) {
                    return systemRequire(originalId);
                } else {
                    throw new Error('No module with ID: ' + id);
                }
            }
        } else {
            //There is a plugin in play.
            prefix = id.substring(0, index);
            id = id.substring(index + 1, id.length);

            plugin = stringRequire(systemRequire, exports, module, prefix, relId);

            if (plugin.normalize) {
                id = plugin.normalize(id, makeNormalize(relId));
            } else {
                //Normalize the ID normally.
                id = normalize(id, relId);
            }

            if (loaderCache[id]) {
                return loaderCache[id];
            } else {
                plugin.load(id, makeRequire(systemRequire, exports, module, relId), makeLoad(id), {});

                return loaderCache[id];
            }
        }
    };

    //Create a define function specific to the module asking for amdefine.
    function define(id, deps, factory) {
        if (Array.isArray(id)) {
            factory = deps;
            deps = id;
            id = undefined;
        } else if (typeof id !== 'string') {
            factory = id;
            id = deps = undefined;
        }

        if (deps && !Array.isArray(deps)) {
            factory = deps;
            deps = undefined;
        }

        if (!deps) {
            deps = ['require', 'exports', 'module'];
        }

        //Set up properties for this module. If an ID, then use
        //internal cache. If no ID, then use the external variables
        //for this node module.
        if (id) {
            //Put the module in deep freeze until there is a
            //require call for it.
            defineCache[id] = [id, deps, factory];
        } else {
            runFactory(id, deps, factory);
        }
    }

    //define.require, which has access to all the values in the
    //cache. Useful for AMD modules that all have IDs in the file,
    //but need to finally export a value to node based on one of those
    //IDs.
    define.require = function (id) {
        if (loaderCache[id]) {
            return loaderCache[id];
        }

        if (defineCache[id]) {
            runFactory.apply(null, defineCache[id]);
            return loaderCache[id];
        }
    };

    define.amd = {};

    return define;
}

module.exports = amdefine;

}).call(this,require('_process'),"/node_modules\\escodegen\\node_modules\\source-map\\node_modules\\amdefine\\amdefine.js")
},{"_process":46,"path":45}],25:[function(require,module,exports){
module.exports={
  "name": "escodegen",
  "description": "ECMAScript code generator",
  "homepage": "http://github.com/Constellation/escodegen",
  "main": "escodegen.js",
  "bin": {
    "esgenerate": "./bin/esgenerate.js",
    "escodegen": "./bin/escodegen.js"
  },
  "version": "1.4.1",
  "engines": {
    "node": ">=0.10.0"
  },
  "maintainers": [
    {
      "name": "Yusuke Suzuki",
      "email": "utatane.tea@gmail.com",
      "url": "http://github.com/Constellation"
    }
  ],
  "repository": {
    "type": "git",
    "url": "http://github.com/Constellation/escodegen.git"
  },
  "dependencies": {
    "estraverse": "^1.5.1",
    "esutils": "^1.1.4",
    "esprima": "^1.2.2",
    "source-map": "~0.1.37"
  },
  "optionalDependencies": {
    "source-map": "~0.1.37"
  },
  "devDependencies": {
    "esprima-moz": "*",
    "semver": "^3.0.1",
    "bluebird": "^2.2.2",
    "jshint-stylish": "^0.4.0",
    "chai": "^1.9.1",
    "gulp-mocha": "^1.0.0",
    "gulp-eslint": "^0.1.8",
    "gulp": "^3.8.6",
    "bower-registry-client": "^0.2.1",
    "gulp-jshint": "^1.8.0",
    "commonjs-everywhere": "^0.9.7"
  },
  "licenses": [
    {
      "type": "BSD",
      "url": "http://github.com/Constellation/escodegen/raw/master/LICENSE.BSD"
    }
  ],
  "scripts": {
    "test": "gulp travis",
    "unit-test": "gulp test",
    "lint": "gulp lint",
    "release": "node tools/release.js",
    "build-min": "cjsify -ma path: tools/entry-point.js > escodegen.browser.min.js",
    "build": "cjsify -a path: tools/entry-point.js > escodegen.browser.js"
  },
  "readme": "### Escodegen [![Build Status](https://secure.travis-ci.org/Constellation/escodegen.svg)](http://travis-ci.org/Constellation/escodegen) [![Build Status](https://drone.io/github.com/Constellation/escodegen/status.png)](https://drone.io/github.com/Constellation/escodegen/latest) [![devDependency Status](https://david-dm.org/Constellation/escodegen/dev-status.svg)](https://david-dm.org/Constellation/escodegen#info=devDependencies)\n\nEscodegen ([escodegen](http://github.com/Constellation/escodegen)) is an\n[ECMAScript](http://www.ecma-international.org/publications/standards/Ecma-262.htm)\n(also popularly known as [JavaScript](http://en.wikipedia.org/wiki/JavaScript>JavaScript))\ncode generator from [Mozilla'ss Parser API](https://developer.mozilla.org/en/SpiderMonkey/Parser_API)\nAST. See the [online generator](https://constellation.github.io/escodegen/demo/index.html)\nfor a demo.\n\n\n### Install\n\nEscodegen can be used in a web browser:\n\n    <script src=\"escodegen.browser.js\"></script>\n\nescodegen.browser.js can be found in tagged revisions on GitHub.\n\nOr in a Node.js application via npm:\n\n    npm install escodegen\n\n### Usage\n\nA simple example: the program\n\n    escodegen.generate({\n        type: 'BinaryExpression',\n        operator: '+',\n        left: { type: 'Literal', value: 40 },\n        right: { type: 'Literal', value: 2 }\n    });\n\nproduces the string `'40 + 2'`.\n\nSee the [API page](https://github.com/Constellation/escodegen/wiki/API) for\noptions. To run the tests, execute `npm test` in the root directory.\n\n### Building browser bundle / minified browser bundle\n\nAt first, execute `npm install` to install the all dev dependencies.\nAfter that,\n\n    npm run-script build\n\nwill generate `escodegen.browser.js`, which can be used in browser environments.\n\nAnd,\n\n    npm run-script build-min\n\nwill generate the minified file `escodegen.browser.min.js`.\n\n### License\n\n#### Escodegen\n\nCopyright (C) 2012 [Yusuke Suzuki](http://github.com/Constellation)\n (twitter: [@Constellation](http://twitter.com/Constellation)) and other contributors.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n  * Redistributions of source code must retain the above copyright\n    notice, this list of conditions and the following disclaimer.\n\n  * Redistributions in binary form must reproduce the above copyright\n    notice, this list of conditions and the following disclaimer in the\n    documentation and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\"\nAND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE\nIMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE\nARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY\nDIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES\n(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;\nLOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND\nON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT\n(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF\nTHIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n\n#### source-map\n\nSourceNodeMocks has a limited interface of mozilla/source-map SourceNode implementations.\n\nCopyright (c) 2009-2011, Mozilla Foundation and contributors\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n* Redistributions of source code must retain the above copyright notice, this\n  list of conditions and the following disclaimer.\n\n* Redistributions in binary form must reproduce the above copyright notice,\n  this list of conditions and the following disclaimer in the documentation\n  and/or other materials provided with the distribution.\n\n* Neither the names of the Mozilla Foundation nor the names of project\n  contributors may be used to endorse or promote products derived from this\n  software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND\nANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED\nWARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\nDISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE\nFOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL\nDAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\nSERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER\nCAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,\nOR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n",
  "readmeFilename": "README.md",
  "bugs": {
    "url": "https://github.com/Constellation/escodegen/issues"
  },
  "_id": "escodegen@1.4.1",
  "dist": {
    "shasum": "037ea4c9d888c4118292e309c15706f091366cb0"
  },
  "_from": "escodegen@1.4.1",
  "_resolved": "https://registry.npmjs.org/escodegen/-/escodegen-1.4.1.tgz"
}

},{}],26:[function(require,module,exports){
arguments[4][1][0].apply(exports,arguments)
},{"./lib":28,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\analyses\\index.js":1}],27:[function(require,module,exports){

module.exports = dot;

var codegen = require('escodegen');

function dot(cfg, options) {
	options = options || {};
	var counter = options.counter || 0;
	var source = options.source;
	var generateSource = !source && options.generateSource;
	
	var output = [];
	var nodes = cfg[2];

	// print all the nodes:
	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		var label = node.label || node.type;
		if (!label && source && node.astNode.range) {
			var ast = node.astNode;
			var range = ast.range;
			var add = '';
			// special case some statements to get them properly printed
			if (ast.type == 'SwitchCase') {
				if (ast.test) {
					range = [range[0], ast.test.range[1]];
					add = ':';
				} else {
					range = [range[0], range[0]];
					add ='default:';
				}
			} else if (ast.type == 'ForInStatement') {
				range = [range[0], ast.right.range[1]];
				add = ')';
			} else if (ast.type == 'CatchClause') {
				range = [range[0], ast.param.range[1]];
				add = ')';
			}

			label = source.slice(range[0], range[1])
				.replace(/\n/g, '\\n')
				.replace(/\t/g, '    ')
				.replace(/"/g, '\\"') + add;
		}
		if (!label && node.astNode) {
			label = generateSource ? codegen.generate(node.astNode) : node.astNode.type;
		}
		output.push('n' + (counter + i) + ' [label="' + label + '"');
		if (~['entry', 'exit'].indexOf(node.type))
			output.push(', style="rounded"');
		output.push(']\n');
	}

	// print all the edges:
	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		['normal', 'true', 'false', 'exception'].forEach(function (type) {
			var next = node[type];
			if (!next)
				return;

		output.push('n' + (counter + i) + ' -> n' + (counter + nodes.indexOf(next)) + ' [');
		if (type === 'exception')
			output.push('color="red", label="exception"')
		else if (~['true', 'false'].indexOf(type))
			output.push('label="' + type + '"');
		output.push(']\n');
		});
	}

	if (options.counter !== undefined)
		options.counter+= nodes.length;

	return output.join('');
}


},{"escodegen":29}],28:[function(require,module,exports){

var walker = require('walkes');

module.exports = ControlFlowGraph;
module.exports.dot = require('./dot');

// FIXME: switch/case with default before other cases?
// FIXME: catch creates a new scope, so should somehow be handled differently

// TODO: try/finally: finally follows try, but does not return to normal flow?

// TODO: labeled break/continue
// TODO: WithStatement

// TODO: avoid adding and deleting properties on ast nodes

/**
 * Returns [entry, exit] `FlowNode`s for the passed in AST
 */
function ControlFlowGraph(astNode, options) {
    options = options || {};
    var parentStack = [];
	var exitNode = new FlowNode(undefined, undefined, 'exit');
	var catchStack = [exitNode];
	var omitExceptions = !!options.omitExceptions;

	createNodes(astNode);
	linkSiblings(astNode);
	
	walker(astNode, {
		CatchClause: function (recurse) {
			this.cfg.connect(getEntry(this.body));
			recurse(this.body);
		},
		DoWhileStatement: function (recurse) {
			mayThrow(this.test);
			this.test.cfg
				.connect(getEntry(this.body), 'true')
				.connect(getSuccessor(this), 'false');
			recurse(this.body);
		},
		ExpressionStatement: connectNext,
		FunctionDeclaration: function () {},
		ForStatement: function (recurse) {
			if (this.test) {
				mayThrow(this.test);
				this.test.cfg
					.connect(getEntry(this.body), 'true')
					.connect(getSuccessor(this), 'false');
				if (this.update)
					this.update.cfg.connect(this.test.cfg);
			} else if (this.update)
				this.update.cfg.connect(getEntry(this.body));
			if (this.update)
				mayThrow(this.update);
			if (this.init) {
				mayThrow(this.init);
				this.init.cfg.connect(this.test && this.test.cfg || getEntry(this.body));
			}
			recurse(this.body);
		},
		ForInStatement: function (recurse) {
			mayThrow(this)
			this.cfg
				.connect(getEntry(this.body), 'true')
				.connect(getSuccessor(this), 'false');
			recurse(this.body);
		},
		IfStatement: function (recurse) {
			recurse(this.consequent);
			mayThrow(this.test);
			this.test.cfg.connect(getEntry(this.consequent), 'true');
			if (this.alternate) {
				recurse(this.alternate);
				this.test.cfg.connect(getEntry(this.alternate), 'false');
			} else {
				this.test.cfg.connect(getSuccessor(this), 'false');
			}
		},
		ReturnStatement: function () {
			mayThrow(this);
			this.cfg.connect(exitNode);
		},
		SwitchCase: function (recurse) {
			if (this.test) {
				// if this is a real case, connect `true` to the body
				// or the body of the next case
				var check = this;
				while (!check.consequent.length && check.cfg.nextSibling)
					check = check.cfg.nextSibling.astNode;

				this.cfg.connect(check.consequent.length && getEntry(check.consequent[0]) || getSuccessor(this.cfg.parent), 'true');

				// and connect false to the next `case`
				this.cfg.connect(getSuccessor(this), 'false');
			} else {
				// this is the `default` case, connect it to the body, or the
				// successor of the parent
				this.cfg.connect(this.consequent.length && getEntry(this.consequent[0]) || getSuccessor(this.cfg.parent));
			}
			this.consequent.forEach(recurse);
		},
		SwitchStatement: function (recurse) {
			this.cfg.connect(this.cases[0].cfg);
			this.cases.forEach(recurse);
		},
		ThrowStatement: function () {
			this.cfg.connect(getExceptionTarget(this), 'exception');
		},
		TryStatement: function (recurse) {
			var handler = this.handlers[0] && this.handlers[0].cfg || getEntry(this.finalizer);
			catchStack.push(handler);
			recurse(this.block);
			catchStack.pop();
			
			if (this.handlers.length)
				recurse(this.handlers[0]);
			if (this.finalizer) {
				//this.finalizer.cfg.connect(getSuccessor(this));
				recurse(this.finalizer);
			}
		},
		VariableDeclaration: connectNext,
		WhileStatement: function (recurse) {
			mayThrow(this.test);
			this.test.cfg
				.connect(getEntry(this.body), 'true')
				.connect(getSuccessor(this), 'false');
			recurse(this.body);
		}
	});
	
	var entryNode = new FlowNode(astNode, undefined, 'entry');
	entryNode.normal = getEntry(astNode);
	walker(astNode, {default: function () {
		if (!this.cfg)
			return;
		// ExpressionStatements should refer to their expression directly
		if (this.type === 'ExpressionStatement')
			this.cfg.astNode = this.expression;
		delete this.cfg;
		walker.checkProps.apply(this, arguments);
	}});

	var allNodes = [];
	var reverseStack = [entryNode];
	while (reverseStack.length) {
		var cfgNode = reverseStack.pop();
		allNodes.push(cfgNode);
		cfgNode.next = [];
		['exception', 'false', 'true', 'normal'].forEach(function (type) {
			var next = cfgNode[type];
			if (!next)
				return;
			if (!~cfgNode.next.indexOf(next))
				cfgNode.next.push(next);
			if (!~next.prev.indexOf(cfgNode))
				next.prev.push(cfgNode);
			if (!~reverseStack.indexOf(next) && !next.next)
				reverseStack.push(next);
		});
	}

	function getExceptionTarget(astNode) {
		return catchStack[catchStack.length - 1];
	}

	function mayThrow(astNode) {
		if (!omitExceptions && expressionThrows(astNode))
			astNode.cfg.connect(getExceptionTarget(this), 'exception');
	}
	function expressionThrows(astNode) {
		if (typeof astNode !== 'object' || 'FunctionExpression' === astNode.type)
			return false;
		if (astNode.type && ~throwTypes.indexOf(astNode.type))
			return true;
		var self = astNode;
		return Object.keys(self).some(function (key) {
			var prop = self[key];
			if (prop instanceof Array) {
				return prop.some(expressionThrows);
			} else if (typeof prop === 'object' && prop)
				return expressionThrows(prop);
			else
				return false;
		});
	}

	function getJumpTarget(astNode, types) {
		var parent = astNode.cfg.parent;
		while (!~types.indexOf(parent.type) && parent.cfg.parent)
			parent = parent.cfg.parent;
		return ~types.indexOf(parent.type) ? parent : null;
	}

	function connectNext() {
		mayThrow(this);
		this.cfg.connect(getSuccessor(this));
	}

	/**
	 * Returns the entry node of a statement
	 */
	function getEntry(astNode) {
		switch (astNode.type) {
			case 'BreakStatement':
				var target = getJumpTarget(astNode, breakTargets);
				return target ? getSuccessor(target) : exitNode;
			case 'ContinueStatement':
				var target = getJumpTarget(astNode, continueTargets);
				switch (target.type) {
					case 'ForStatement':
						// continue goes to the update, test or body
						return target.update && target.update.cfg || target.test && target.test.cfg || getEntry(target.body);
					case 'ForInStatement':
						return target.cfg;
					case 'DoWhileStatement':
					case 'WhileStatement':
						return target.test.cfg;
				}
				// unreached
			case 'BlockStatement':
			case 'Program':
				return astNode.body.length && getEntry(astNode.body[0]) || getSuccessor(astNode);
			case 'DoWhileStatement':
				return getEntry(astNode.body);
			case 'EmptyStatement':
				return getSuccessor(astNode);
			case 'ForStatement':
				return astNode.init && astNode.init.cfg || astNode.test && astNode.test.cfg || getEntry(astNode.body);
			case 'FunctionDeclaration':
				return getSuccessor(astNode);
			case 'IfStatement':
				return astNode.test.cfg;
			case 'SwitchStatement':
				return getEntry(astNode.cases[0]);
			case 'TryStatement':
				return getEntry(astNode.block);
			case 'WhileStatement':
				return astNode.test.cfg;
			default:
				return astNode.cfg;
		}
	}
	/**
	 * Returns the successor node of a statement
	 */
	function getSuccessor(astNode) {
		// part of a block -> it already has a nextSibling
		if (astNode.cfg.nextSibling)
			return astNode.cfg.nextSibling;
		var parent = astNode.cfg.parent;
		if (!parent) // it has no parent -> exitNode
			return exitNode;
		switch (parent.type) {
			case 'DoWhileStatement':
				return parent.test.cfg;
			case 'ForStatement':
				return parent.update && parent.update.cfg || parent.test && parent.test.cfg || getEntry(parent.body);
			case 'ForInStatement':
				return parent.cfg;
			case 'TryStatement':
				return parent.finalizer && astNode !== parent.finalizer && getEntry(parent.finalizer) || getSuccessor(parent);
			case 'SwitchCase':
				// the sucessor of a statement at the end of a case block is
				// the entry of the next cases consequent
				if (!parent.cfg.nextSibling)
					return getSuccessor(parent);
				var check = parent.cfg.nextSibling.astNode;
				while (!check.consequent.length && check.cfg.nextSibling)
					check = check.cfg.nextSibling.astNode;
				// or the next statement after the switch, if there are no more cases
				return check.consequent.length && getEntry(check.consequent[0]) || getSuccessor(parent.parent);
			case 'WhileStatement':
				return parent.test.cfg;
			default:
				return getSuccessor(parent);
		}
	}

	/**
	 * Creates a FlowNode for every AST node
	 */
	function createNodes(astNode) {
		walker(astNode, { default: function () {
			var parent = parentStack.length ? parentStack[parentStack.length - 1] : undefined;
			createNode(this, parent);
			// do not recurse for FunctionDeclaration or any sub-expression
			if (this.type == 'FunctionDeclaration' || ~this.type.indexOf('Expression'))
				return;
			parentStack.push(this);
			walker.checkProps.apply(this, arguments);
			parentStack.pop();
		}});
	}
	function createNode(astNode, parent) {
		if (!astNode.cfg)
			Object.defineProperty(astNode, 'cfg', {value: new FlowNode(astNode, parent), configurable: true});
	}

	/**
	 * Links in the next sibling for nodes inside a block
	 */
	function linkSiblings(astNode) {
		function backToFront(list, recurse) {
			// link all the children to the next sibling from back to front,
			// so the nodes already have .nextSibling
			// set when their getEntry is called
			for (var i = list.length - 1; i >= 0; i--) {
				var child = list[i];
				if (i < list.length - 1)
					child.cfg.nextSibling = getEntry(list[i + 1]);
				recurse(child);
			}
		}
		function BlockOrProgram(recurse) {
			backToFront(this.body, recurse);
		}
		walker(astNode, {
			BlockStatement: BlockOrProgram,
			Program: BlockOrProgram,
			FunctionDeclaration: function () {},
			FunctionExpression: function () {},
			SwitchCase: function (recurse) {
				backToFront(this.consequent, recurse);
			},
			SwitchStatement: function (recurse) {
				backToFront(this.cases, recurse);
			},
		});
	}
	return [entryNode, exitNode, allNodes];
};

function FlowNode(astNode, parent, type) {
	this.astNode = astNode;
	this.parent = parent;
	this.type = type;
	this.prev = [];
}
FlowNode.prototype.connect = function (next, type) {
	this[type || 'normal'] = next;
	return this;
};

var continueTargets = [
	'ForStatement',
	'ForInStatement',
	'DoWhileStatement',
	'WhileStatement'];
var breakTargets = continueTargets.concat(['SwitchStatement']);
var throwTypes = [
	'AssignmentExpression', // assigning to undef or non-writable prop
	'BinaryExpression', // instanceof and in on non-objects
	'CallExpression', // obviously
	'MemberExpression', // getters may throw
	'NewExpression', // obviously
	'UnaryExpression' // delete non-deletable prop
];


},{"./dot":27,"walkes":49}],29:[function(require,module,exports){
(function (global){
/*
  Copyright (C) 2012-2013 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012-2013 Michael Ficarra <escodegen.copyright@michael.ficarra.me>
  Copyright (C) 2012-2013 Mathias Bynens <mathias@qiwi.be>
  Copyright (C) 2013 Irakli Gozalishvili <rfobic@gmail.com>
  Copyright (C) 2012 Robert Gust-Bardon <donate@robert.gust-bardon.org>
  Copyright (C) 2012 John Freeman <jfreeman08@gmail.com>
  Copyright (C) 2011-2012 Ariya Hidayat <ariya.hidayat@gmail.com>
  Copyright (C) 2012 Joost-Wim Boekesteijn <joost-wim@boekesteijn.nl>
  Copyright (C) 2012 Kris Kowal <kris.kowal@cixar.com>
  Copyright (C) 2012 Arpad Borsos <arpad.borsos@googlemail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*global exports:true, generateStatement:true, generateExpression:true, require:true, global:true*/
(function () {
    'use strict';

    var Syntax,
        Precedence,
        BinaryPrecedence,
        Regex,
        SourceNode,
        estraverse,
        isArray,
        base,
        indent,
        json,
        renumber,
        hexadecimal,
        quotes,
        escapeless,
        newline,
        space,
        parentheses,
        semicolons,
        safeConcatenation,
        directive,
        extra,
        parse,
        sourceMap,
        FORMAT_MINIFY,
        FORMAT_DEFAULTS;

    estraverse = require('estraverse');

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        ArrayExpression: 'ArrayExpression',
        ArrayPattern: 'ArrayPattern',
        ArrowFunctionExpression: 'ArrowFunctionExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ComprehensionBlock: 'ComprehensionBlock',
        ComprehensionExpression: 'ComprehensionExpression',
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DirectiveStatement: 'DirectiveStatement',
        DoWhileStatement: 'DoWhileStatement',
        DebuggerStatement: 'DebuggerStatement',
        EmptyStatement: 'EmptyStatement',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForInStatement: 'ForInStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        ObjectPattern: 'ObjectPattern',
        Program: 'Program',
        Property: 'Property',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SwitchStatement: 'SwitchStatement',
        SwitchCase: 'SwitchCase',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement',
        YieldExpression: 'YieldExpression'

    };

    Precedence = {
        Sequence: 0,
        Assignment: 1,
        Conditional: 2,
        ArrowFunction: 2,
        LogicalOR: 3,
        LogicalAND: 4,
        BitwiseOR: 5,
        BitwiseXOR: 6,
        BitwiseAND: 7,
        Equality: 8,
        Relational: 9,
        BitwiseSHIFT: 10,
        Additive: 11,
        Multiplicative: 12,
        Unary: 13,
        Postfix: 14,
        Call: 15,
        New: 16,
        Member: 17,
        Primary: 18
    };

    BinaryPrecedence = {
        '||': Precedence.LogicalOR,
        '&&': Precedence.LogicalAND,
        '|': Precedence.BitwiseOR,
        '^': Precedence.BitwiseXOR,
        '&': Precedence.BitwiseAND,
        '==': Precedence.Equality,
        '!=': Precedence.Equality,
        '===': Precedence.Equality,
        '!==': Precedence.Equality,
        'is': Precedence.Equality,
        'isnt': Precedence.Equality,
        '<': Precedence.Relational,
        '>': Precedence.Relational,
        '<=': Precedence.Relational,
        '>=': Precedence.Relational,
        'in': Precedence.Relational,
        'instanceof': Precedence.Relational,
        '<<': Precedence.BitwiseSHIFT,
        '>>': Precedence.BitwiseSHIFT,
        '>>>': Precedence.BitwiseSHIFT,
        '+': Precedence.Additive,
        '-': Precedence.Additive,
        '*': Precedence.Multiplicative,
        '%': Precedence.Multiplicative,
        '/': Precedence.Multiplicative
    };

    Regex = {
        NonAsciiIdentifierPart: new RegExp('[\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0300-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u0483-\u0487\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u05d0-\u05ea\u05f0-\u05f2\u0610-\u061a\u0620-\u0669\u066e-\u06d3\u06d5-\u06dc\u06df-\u06e8\u06ea-\u06fc\u06ff\u0710-\u074a\u074d-\u07b1\u07c0-\u07f5\u07fa\u0800-\u082d\u0840-\u085b\u08a0\u08a2-\u08ac\u08e4-\u08fe\u0900-\u0963\u0966-\u096f\u0971-\u0977\u0979-\u097f\u0981-\u0983\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bc-\u09c4\u09c7\u09c8\u09cb-\u09ce\u09d7\u09dc\u09dd\u09df-\u09e3\u09e6-\u09f1\u0a01-\u0a03\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a59-\u0a5c\u0a5e\u0a66-\u0a75\u0a81-\u0a83\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abc-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ad0\u0ae0-\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3c-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b5c\u0b5d\u0b5f-\u0b63\u0b66-\u0b6f\u0b71\u0b82\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd0\u0bd7\u0be6-\u0bef\u0c01-\u0c03\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c58\u0c59\u0c60-\u0c63\u0c66-\u0c6f\u0c82\u0c83\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbc-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0cde\u0ce0-\u0ce3\u0ce6-\u0cef\u0cf1\u0cf2\u0d02\u0d03\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d-\u0d44\u0d46-\u0d48\u0d4a-\u0d4e\u0d57\u0d60-\u0d63\u0d66-\u0d6f\u0d7a-\u0d7f\u0d82\u0d83\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2\u0df3\u0e01-\u0e3a\u0e40-\u0e4e\u0e50-\u0e59\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb9\u0ebb-\u0ebd\u0ec0-\u0ec4\u0ec6\u0ec8-\u0ecd\u0ed0-\u0ed9\u0edc-\u0edf\u0f00\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f3e-\u0f47\u0f49-\u0f6c\u0f71-\u0f84\u0f86-\u0f97\u0f99-\u0fbc\u0fc6\u1000-\u1049\u1050-\u109d\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u135d-\u135f\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176c\u176e-\u1770\u1772\u1773\u1780-\u17d3\u17d7\u17dc\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u1820-\u1877\u1880-\u18aa\u18b0-\u18f5\u1900-\u191c\u1920-\u192b\u1930-\u193b\u1946-\u196d\u1970-\u1974\u1980-\u19ab\u19b0-\u19c9\u19d0-\u19d9\u1a00-\u1a1b\u1a20-\u1a5e\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1aa7\u1b00-\u1b4b\u1b50-\u1b59\u1b6b-\u1b73\u1b80-\u1bf3\u1c00-\u1c37\u1c40-\u1c49\u1c4d-\u1c7d\u1cd0-\u1cd2\u1cd4-\u1cf6\u1d00-\u1de6\u1dfc-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u200c\u200d\u203f\u2040\u2054\u2071\u207f\u2090-\u209c\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d7f-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2de0-\u2dff\u2e2f\u3005-\u3007\u3021-\u302f\u3031-\u3035\u3038-\u303c\u3041-\u3096\u3099\u309a\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua62b\ua640-\ua66f\ua674-\ua67d\ua67f-\ua697\ua69f-\ua6f1\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua827\ua840-\ua873\ua880-\ua8c4\ua8d0-\ua8d9\ua8e0-\ua8f7\ua8fb\ua900-\ua92d\ua930-\ua953\ua960-\ua97c\ua980-\ua9c0\ua9cf-\ua9d9\uaa00-\uaa36\uaa40-\uaa4d\uaa50-\uaa59\uaa60-\uaa76\uaa7a\uaa7b\uaa80-\uaac2\uaadb-\uaadd\uaae0-\uaaef\uaaf2-\uaaf6\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabea\uabec\uabed\uabf0-\uabf9\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe00-\ufe0f\ufe20-\ufe26\ufe33\ufe34\ufe4d-\ufe4f\ufe70-\ufe74\ufe76-\ufefc\uff10-\uff19\uff21-\uff3a\uff3f\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc]')
    };

    function getDefaultOptions() {
        // default options
        return {
            indent: null,
            base: null,
            parse: null,
            comment: false,
            format: {
                indent: {
                    style: '    ',
                    base: 0,
                    adjustMultilineComment: false
                },
                newline: '\n',
                space: ' ',
                json: false,
                renumber: false,
                hexadecimal: false,
                quotes: 'single',
                escapeless: false,
                compact: false,
                parentheses: true,
                semicolons: true,
                safeConcatenation: false
            },
            moz: {
                starlessGenerator: false,
                parenthesizedComprehensionBlock: false
            },
            sourceMap: null,
            sourceMapRoot: null,
            sourceMapWithCode: false,
            directive: false,
            verbatim: null
        };
    }

    function stringToArray(str) {
        var length = str.length,
            result = [],
            i;
        for (i = 0; i < length; i += 1) {
            result[i] = str.charAt(i);
        }
        return result;
    }

    function stringRepeat(str, num) {
        var result = '';

        for (num |= 0; num > 0; num >>>= 1, str += str) {
            if (num & 1) {
                result += str;
            }
        }

        return result;
    }

    isArray = Array.isArray;
    if (!isArray) {
        isArray = function isArray(array) {
            return Object.prototype.toString.call(array) === '[object Array]';
        };
    }

    // Fallback for the non SourceMap environment
    function SourceNodeMock(line, column, filename, chunk) {
        var result = [];

        function flatten(input) {
            var i, iz;
            if (isArray(input)) {
                for (i = 0, iz = input.length; i < iz; ++i) {
                    flatten(input[i]);
                }
            } else if (input instanceof SourceNodeMock) {
                result.push(input);
            } else if (typeof input === 'string' && input) {
                result.push(input);
            }
        }

        flatten(chunk);
        this.children = result;
    }

    SourceNodeMock.prototype.toString = function toString() {
        var res = '', i, iz, node;
        for (i = 0, iz = this.children.length; i < iz; ++i) {
            node = this.children[i];
            if (node instanceof SourceNodeMock) {
                res += node.toString();
            } else {
                res += node;
            }
        }
        return res;
    };

    SourceNodeMock.prototype.replaceRight = function replaceRight(pattern, replacement) {
        var last = this.children[this.children.length - 1];
        if (last instanceof SourceNodeMock) {
            last.replaceRight(pattern, replacement);
        } else if (typeof last === 'string') {
            this.children[this.children.length - 1] = last.replace(pattern, replacement);
        } else {
            this.children.push(''.replace(pattern, replacement));
        }
        return this;
    };

    SourceNodeMock.prototype.join = function join(sep) {
        var i, iz, result;
        result = [];
        iz = this.children.length;
        if (iz > 0) {
            for (i = 0, iz -= 1; i < iz; ++i) {
                result.push(this.children[i], sep);
            }
            result.push(this.children[iz]);
            this.children = result;
        }
        return this;
    };

    function hasLineTerminator(str) {
        return (/[\r\n]/g).test(str);
    }

    function endsWithLineTerminator(str) {
        var ch = str.charAt(str.length - 1);
        return ch && isLineTerminator(ch);
    }

    function updateDeeply(target, override) {
        var key, val;

        function isHashObject(target) {
            return typeof target === 'object' && target instanceof Object && !(target instanceof RegExp);
        }

        for (key in override) {
            if (override.hasOwnProperty(key)) {
                val = override[key];
                if (isHashObject(val)) {
                    if (isHashObject(target[key])) {
                        updateDeeply(target[key], val);
                    } else {
                        target[key] = updateDeeply({}, val);
                    }
                } else {
                    target[key] = val;
                }
            }
        }
        return target;
    }

    function generateNumber(value) {
        var result, point, temp, exponent, pos;

        if (value !== value) {
            throw new Error('Numeric literal whose value is NaN');
        }
        if (value < 0 || (value === 0 && 1 / value < 0)) {
            throw new Error('Numeric literal whose value is negative');
        }

        if (value === 1 / 0) {
            return json ? 'null' : renumber ? '1e400' : '1e+400';
        }

        result = '' + value;
        if (!renumber || result.length < 3) {
            return result;
        }

        point = result.indexOf('.');
        if (!json && result.charAt(0) === '0' && point === 1) {
            point = 0;
            result = result.slice(1);
        }
        temp = result;
        result = result.replace('e+', 'e');
        exponent = 0;
        if ((pos = temp.indexOf('e')) > 0) {
            exponent = +temp.slice(pos + 1);
            temp = temp.slice(0, pos);
        }
        if (point >= 0) {
            exponent -= temp.length - point - 1;
            temp = +(temp.slice(0, point) + temp.slice(point + 1)) + '';
        }
        pos = 0;
        while (temp.charAt(temp.length + pos - 1) === '0') {
            pos -= 1;
        }
        if (pos !== 0) {
            exponent -= pos;
            temp = temp.slice(0, pos);
        }
        if (exponent !== 0) {
            temp += 'e' + exponent;
        }
        if ((temp.length < result.length ||
                    (hexadecimal && value > 1e12 && Math.floor(value) === value && (temp = '0x' + value.toString(16)).length < result.length)) &&
                +temp === value) {
            result = temp;
        }

        return result;
    }

    // Generate valid RegExp expression.
    // This function is based on https://github.com/Constellation/iv Engine

    function escapeRegExpCharacter(ch, previousIsBackslash) {
        // not handling '\' and handling \u2028 or \u2029 to unicode escape sequence
        if ((ch & ~1) === 0x2028) {
            return (previousIsBackslash ? 'u' : '\\u') + ((ch === 0x2028) ? '2028' : '2029');
        } else if (ch === 10 || ch === 13) {  // \n, \r
            return (previousIsBackslash ? '' : '\\') + ((ch === 10) ? 'n' : 'r');
        }
        return String.fromCharCode(ch);
    }

    function generateRegExp(reg) {
        var match, result, flags, i, iz, ch, characterInBrack, previousIsBackslash;

        result = reg.toString();

        if (reg.source) {
            // extract flag from toString result
            match = result.match(/\/([^/]*)$/);
            if (!match) {
                return result;
            }

            flags = match[1];
            result = '';

            characterInBrack = false;
            previousIsBackslash = false;
            for (i = 0, iz = reg.source.length; i < iz; ++i) {
                ch = reg.source.charCodeAt(i);

                if (!previousIsBackslash) {
                    if (characterInBrack) {
                        if (ch === 93) {  // ]
                            characterInBrack = false;
                        }
                    } else {
                        if (ch === 47) {  // /
                            result += '\\';
                        } else if (ch === 91) {  // [
                            characterInBrack = true;
                        }
                    }
                    result += escapeRegExpCharacter(ch, previousIsBackslash);
                    previousIsBackslash = ch === 92;  // \
                } else {
                    // if new RegExp("\\\n') is provided, create /\n/
                    result += escapeRegExpCharacter(ch, previousIsBackslash);
                    // prevent like /\\[/]/
                    previousIsBackslash = false;
                }
            }

            return '/' + result + '/' + flags;
        }

        return result;
    }

    function escapeAllowedCharacter(ch, next) {
        var code = ch.charCodeAt(0), hex = code.toString(16), result = '\\';

        switch (ch) {
        case '\b':
            result += 'b';
            break;
        case '\f':
            result += 'f';
            break;
        case '\t':
            result += 't';
            break;
        default:
            if (json || code > 0xff) {
                result += 'u' + '0000'.slice(hex.length) + hex;
            } else if (ch === '\u0000' && '0123456789'.indexOf(next) < 0) {
                result += '0';
            } else if (ch === '\x0B') { // '\v'
                result += 'x0B';
            } else {
                result += 'x' + '00'.slice(hex.length) + hex;
            }
            break;
        }

        return result;
    }

    function escapeDisallowedCharacter(ch) {
        var result = '\\';
        switch (ch) {
        case '\\':
            result += '\\';
            break;
        case '\n':
            result += 'n';
            break;
        case '\r':
            result += 'r';
            break;
        case '\u2028':
            result += 'u2028';
            break;
        case '\u2029':
            result += 'u2029';
            break;
        default:
            throw new Error('Incorrectly classified character');
        }

        return result;
    }

    function escapeDirective(str) {
        var i, iz, ch, buf, quote;

        buf = str;
        if (typeof buf[0] === 'undefined') {
            buf = stringToArray(buf);
        }

        quote = quotes === 'double' ? '"' : '\'';
        for (i = 0, iz = buf.length; i < iz; i += 1) {
            ch = buf[i];
            if (ch === '\'') {
                quote = '"';
                break;
            } else if (ch === '"') {
                quote = '\'';
                break;
            } else if (ch === '\\') {
                i += 1;
            }
        }

        return quote + str + quote;
    }

    function escapeString(str) {
        var result = '', i, len, ch, singleQuotes = 0, doubleQuotes = 0, single;

        if (typeof str[0] === 'undefined') {
            str = stringToArray(str);
        }

        for (i = 0, len = str.length; i < len; i += 1) {
            ch = str[i];
            if (ch === '\'') {
                singleQuotes += 1;
            } else if (ch === '"') {
                doubleQuotes += 1;
            } else if (ch === '/' && json) {
                result += '\\';
            } else if ('\\\n\r\u2028\u2029'.indexOf(ch) >= 0) {
                result += escapeDisallowedCharacter(ch);
                continue;
            } else if ((json && ch < ' ') || !(json || escapeless || (ch >= ' ' && ch <= '~'))) {
                result += escapeAllowedCharacter(ch, str[i + 1]);
                continue;
            }
            result += ch;
        }

        single = !(quotes === 'double' || (quotes === 'auto' && doubleQuotes < singleQuotes));
        str = result;
        result = single ? '\'' : '"';

        if (typeof str[0] === 'undefined') {
            str = stringToArray(str);
        }

        for (i = 0, len = str.length; i < len; i += 1) {
            ch = str[i];
            if ((ch === '\'' && single) || (ch === '"' && !single)) {
                result += '\\';
            }
            result += ch;
        }

        return result + (single ? '\'' : '"');
    }

    function isWhiteSpace(ch) {
        // Use `\x0B` instead of `\v` for IE < 9 compatibility
        return '\t\x0B\f \xa0'.indexOf(ch) >= 0 || (ch.charCodeAt(0) >= 0x1680 && '\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\ufeff'.indexOf(ch) >= 0);
    }

    function isLineTerminator(ch) {
        return '\n\r\u2028\u2029'.indexOf(ch) >= 0;
    }

    function isIdentifierPart(ch) {
        return (ch === '$') || (ch === '_') || (ch === '\\') ||
            (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
            ((ch >= '0') && (ch <= '9')) ||
            ((ch.charCodeAt(0) >= 0x80) && Regex.NonAsciiIdentifierPart.test(ch));
    }

    // takes char code
    function isDecimalDigit(ch) {
        return (ch >= 48 && ch <= 57);   // 0..9
    }

    function toSourceNode(generated, node) {
        if (node == null) {
            if (generated instanceof SourceNode) {
                return generated;
            } else {
                node = {};
            }
        }
        if (node.loc == null) {
            return new SourceNode(null, null, sourceMap, generated, node.name || null);
        }
        return new SourceNode(node.loc.start.line, node.loc.start.column, (sourceMap === true ? node.loc.source || null : sourceMap), generated, node.name || null);
    }

    function noEmptySpace() {
        return (space) ? space : ' ';
    }

    function join(left, right) {
        var leftSource = toSourceNode(left).toString(),
            rightSource = toSourceNode(right).toString(),
            leftChar = leftSource.charAt(leftSource.length - 1),
            rightChar = rightSource.charAt(0);

        if ((leftChar === '+' || leftChar === '-') && leftChar === rightChar ||
        isIdentifierPart(leftChar) && isIdentifierPart(rightChar) ||
        leftChar === '/' && rightChar === 'i') { // infix word operators all start with `i`
            return [left, noEmptySpace(), right];
        } else if (isWhiteSpace(leftChar) || isLineTerminator(leftChar) || isWhiteSpace(rightChar) || isLineTerminator(rightChar)) {
            return [left, right];
        }
        return [left, space, right];
    }

    function addIndent(stmt) {
        return [base, stmt];
    }

    function withIndent(fn) {
        var previousBase, result;
        previousBase = base;
        base += indent;
        result = fn.call(this, base);
        base = previousBase;
        return result;
    }

    function calculateSpaces(str) {
        var i;
        for (i = str.length - 1; i >= 0; i -= 1) {
            if (isLineTerminator(str.charAt(i))) {
                break;
            }
        }
        return (str.length - 1) - i;
    }

    function adjustMultilineComment(value, specialBase) {
        var array, i, len, line, j, spaces, previousBase;

        array = value.split(/\r\n|[\r\n]/);
        spaces = Number.MAX_VALUE;

        // first line doesn't have indentation
        for (i = 1, len = array.length; i < len; i += 1) {
            line = array[i];
            j = 0;
            while (j < line.length && isWhiteSpace(line[j])) {
                j += 1;
            }
            if (spaces > j) {
                spaces = j;
            }
        }

        if (typeof specialBase !== 'undefined') {
            // pattern like
            // {
            //   var t = 20;  /*
            //                 * this is comment
            //                 */
            // }
            previousBase = base;
            if (array[1][spaces] === '*') {
                specialBase += ' ';
            }
            base = specialBase;
        } else {
            if (spaces & 1) {
                // /*
                //  *
                //  */
                // If spaces are odd number, above pattern is considered.
                // We waste 1 space.
                spaces -= 1;
            }
            previousBase = base;
        }

        for (i = 1, len = array.length; i < len; i += 1) {
            array[i] = toSourceNode(addIndent(array[i].slice(spaces))).join('');
        }

        base = previousBase;

        return array.join('\n');
    }

    function generateComment(comment, specialBase) {
        if (comment.type === 'Line') {
            if (endsWithLineTerminator(comment.value)) {
                return '//' + comment.value;
            } else {
                // Always use LineTerminator
                return '//' + comment.value + '\n';
            }
        }
        if (extra.format.indent.adjustMultilineComment && /[\n\r]/.test(comment.value)) {
            return adjustMultilineComment('/*' + comment.value + '*/', specialBase);
        }
        return '/*' + comment.value + '*/';
    }

    function addCommentsToStatement(stmt, result) {
        var i, len, comment, save, tailingToStatement, specialBase, fragment;

        if (stmt.leadingComments && stmt.leadingComments.length > 0) {
            save = result;

            comment = stmt.leadingComments[0];
            result = [];
            if (safeConcatenation && stmt.type === Syntax.Program && stmt.body.length === 0) {
                result.push('\n');
            }
            result.push(generateComment(comment));
            if (!endsWithLineTerminator(toSourceNode(result).toString())) {
                result.push('\n');
            }

            for (i = 1, len = stmt.leadingComments.length; i < len; i += 1) {
                comment = stmt.leadingComments[i];
                fragment = [generateComment(comment)];
                if (!endsWithLineTerminator(toSourceNode(fragment).toString())) {
                    fragment.push('\n');
                }
                result.push(addIndent(fragment));
            }

            result.push(addIndent(save));
        }

        if (stmt.trailingComments) {
            tailingToStatement = !endsWithLineTerminator(toSourceNode(result).toString());
            specialBase = stringRepeat(' ', calculateSpaces(toSourceNode([base, result, indent]).toString()));
            for (i = 0, len = stmt.trailingComments.length; i < len; i += 1) {
                comment = stmt.trailingComments[i];
                if (tailingToStatement) {
                    // We assume target like following script
                    //
                    // var t = 20;  /**
                    //               * This is comment of t
                    //               */
                    if (i === 0) {
                        // first case
                        result = [result, indent];
                    } else {
                        result = [result, specialBase];
                    }
                    result.push(generateComment(comment, specialBase));
                } else {
                    result = [result, addIndent(generateComment(comment))];
                }
                if (i !== len - 1 && !endsWithLineTerminator(toSourceNode(result).toString())) {
                    result = [result, '\n'];
                }
            }
        }

        return result;
    }

    function parenthesize(text, current, should) {
        if (current < should) {
            return ['(', text, ')'];
        }
        return text;
    }

    function maybeBlock(stmt, semicolonOptional, functionBody) {
        var result, noLeadingComment;

        noLeadingComment = !extra.comment || !stmt.leadingComments;

        if (stmt.type === Syntax.BlockStatement && noLeadingComment) {
            return [space, generateStatement(stmt, { functionBody: functionBody })];
        }

        if (stmt.type === Syntax.EmptyStatement && noLeadingComment) {
            return ';';
        }

        withIndent(function () {
            result = [newline, addIndent(generateStatement(stmt, { semicolonOptional: semicolonOptional, functionBody: functionBody }))];
        });

        return result;
    }

    function maybeBlockSuffix(stmt, result) {
        var ends = endsWithLineTerminator(toSourceNode(result).toString());
        if (stmt.type === Syntax.BlockStatement && (!extra.comment || !stmt.leadingComments) && !ends) {
            return [result, space];
        }
        if (ends) {
            return [result, base];
        }
        return [result, newline, base];
    }

    function generateVerbatim(expr, option) {
        var i, result;
        result = expr[extra.verbatim].split(/\r\n|\n/);
        for (i = 1; i < result.length; i++) {
            result[i] = newline + base + result[i];
        }

        result = parenthesize(result, Precedence.Sequence, option.precedence);
        return toSourceNode(result, expr);
    }

    function generateIdentifier(node) {
        return toSourceNode(node.name, node);
    }

    function generateFunctionBody(node) {
        var result, i, len, expr, arrow;

        arrow = node.type === Syntax.ArrowFunctionExpression;

        if (arrow && node.params.length === 1 && node.params[0].type === Syntax.Identifier) {
            // arg => { } case
            result = [generateIdentifier(node.params[0])];
        } else {
            result = ['('];
            for (i = 0, len = node.params.length; i < len; i += 1) {
                result.push(generateIdentifier(node.params[i]));
                if (i + 1 < len) {
                    result.push(',' + space);
                }
            }
            result.push(')');
        }

        if (arrow) {
            result.push(space, '=>');
        }

        if (node.expression) {
            result.push(space);
            expr = generateExpression(node.body, {
                precedence: Precedence.Assignment,
                allowIn: true,
                allowCall: true
            });
            if (expr.toString().charAt(0) === '{') {
                expr = ['(', expr, ')'];
            }
            result.push(expr);
        } else {
            result.push(maybeBlock(node.body, false, true));
        }
        return result;
    }

    function generateExpression(expr, option) {
        var result,
            precedence,
            type,
            currentPrecedence,
            i,
            len,
            raw,
            fragment,
            multiline,
            leftChar,
            leftSource,
            rightChar,
            allowIn,
            allowCall,
            allowUnparenthesizedNew,
            property;

        precedence = option.precedence;
        allowIn = option.allowIn;
        allowCall = option.allowCall;
        type = expr.type || option.type;

        if (extra.verbatim && expr.hasOwnProperty(extra.verbatim)) {
            return generateVerbatim(expr, option);
        }

        switch (type) {
        case Syntax.SequenceExpression:
            result = [];
            allowIn |= (Precedence.Sequence < precedence);
            for (i = 0, len = expr.expressions.length; i < len; i += 1) {
                result.push(generateExpression(expr.expressions[i], {
                    precedence: Precedence.Assignment,
                    allowIn: allowIn,
                    allowCall: true
                }));
                if (i + 1 < len) {
                    result.push(',' + space);
                }
            }
            result = parenthesize(result, Precedence.Sequence, precedence);
            break;

        case Syntax.AssignmentExpression:
            allowIn |= (Precedence.Assignment < precedence);
            result = parenthesize(
                [
                    generateExpression(expr.left, {
                        precedence: Precedence.Call,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space + expr.operator + space,
                    generateExpression(expr.right, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    })
                ],
                Precedence.Assignment,
                precedence
            );
            break;

        case Syntax.ArrowFunctionExpression:
            allowIn |= (Precedence.ArrowFunction < precedence);
            result = parenthesize(generateFunctionBody(expr), Precedence.ArrowFunction, precedence);
            break;

        case Syntax.ConditionalExpression:
            allowIn |= (Precedence.Conditional < precedence);
            result = parenthesize(
                [
                    generateExpression(expr.test, {
                        precedence: Precedence.LogicalOR,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space + '?' + space,
                    generateExpression(expr.consequent, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space + ':' + space,
                    generateExpression(expr.alternate, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    })
                ],
                Precedence.Conditional,
                precedence
            );
            break;

        case Syntax.LogicalExpression:
        case Syntax.BinaryExpression:
            currentPrecedence = BinaryPrecedence[expr.operator];

            allowIn |= (currentPrecedence < precedence);

            fragment = generateExpression(expr.left, {
                precedence: currentPrecedence,
                allowIn: allowIn,
                allowCall: true
            });

            leftSource = fragment.toString();

            if (leftSource.charAt(leftSource.length - 1) === '/' && isIdentifierPart(expr.operator.charAt(0))) {
                result = [fragment, noEmptySpace(), expr.operator];
            } else {
                result = join(fragment, expr.operator);
            }

            fragment = generateExpression(expr.right, {
                precedence: currentPrecedence + 1,
                allowIn: allowIn,
                allowCall: true
            });

            if (expr.operator === '/' && fragment.toString().charAt(0) === '/' ||
            expr.operator.slice(-1) === '<' && fragment.toString().slice(0, 3) === '!--') {
                // If '/' concats with '/' or `<` concats with `!--`, it is interpreted as comment start
                result.push(noEmptySpace(), fragment);
            } else {
                result = join(result, fragment);
            }

            if (expr.operator === 'in' && !allowIn) {
                result = ['(', result, ')'];
            } else {
                result = parenthesize(result, currentPrecedence, precedence);
            }

            break;

        case Syntax.CallExpression:
            result = [generateExpression(expr.callee, {
                precedence: Precedence.Call,
                allowIn: true,
                allowCall: true,
                allowUnparenthesizedNew: false
            })];

            result.push('(');
            for (i = 0, len = expr['arguments'].length; i < len; i += 1) {
                result.push(generateExpression(expr['arguments'][i], {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                }));
                if (i + 1 < len) {
                    result.push(',' + space);
                }
            }
            result.push(')');

            if (!allowCall) {
                result = ['(', result, ')'];
            } else {
                result = parenthesize(result, Precedence.Call, precedence);
            }
            break;

        case Syntax.NewExpression:
            len = expr['arguments'].length;
            allowUnparenthesizedNew = option.allowUnparenthesizedNew === undefined || option.allowUnparenthesizedNew;

            result = join(
                'new',
                generateExpression(expr.callee, {
                    precedence: Precedence.New,
                    allowIn: true,
                    allowCall: false,
                    allowUnparenthesizedNew: allowUnparenthesizedNew && !parentheses && len === 0
                })
            );

            if (!allowUnparenthesizedNew || parentheses || len > 0) {
                result.push('(');
                for (i = 0; i < len; i += 1) {
                    result.push(generateExpression(expr['arguments'][i], {
                        precedence: Precedence.Assignment,
                        allowIn: true,
                        allowCall: true
                    }));
                    if (i + 1 < len) {
                        result.push(',' + space);
                    }
                }
                result.push(')');
            }

            result = parenthesize(result, Precedence.New, precedence);
            break;

        case Syntax.MemberExpression:
            result = [generateExpression(expr.object, {
                precedence: Precedence.Call,
                allowIn: true,
                allowCall: allowCall,
                allowUnparenthesizedNew: false
            })];

            if (expr.computed) {
                result.push('[', generateExpression(expr.property, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: allowCall
                }), ']');
            } else {
                if (expr.object.type === Syntax.Literal && typeof expr.object.value === 'number') {
                    fragment = toSourceNode(result).toString();
                    // When the following conditions are all true,
                    //   1. No floating point
                    //   2. Don't have exponents
                    //   3. The last character is a decimal digit
                    //   4. Not hexadecimal OR octal number literal
                    // we should add a floating point.
                    if (
                            fragment.indexOf('.') < 0 &&
                            !/[eExX]/.test(fragment) &&
                            isDecimalDigit(fragment.charCodeAt(fragment.length - 1)) &&
                            !(fragment.length >= 2 && fragment.charCodeAt(0) === 48)  // '0'
                            ) {
                        result.push('.');
                    }
                }
                result.push('.', generateIdentifier(expr.property));
            }

            result = parenthesize(result, Precedence.Member, precedence);
            break;

        case Syntax.UnaryExpression:
            fragment = generateExpression(expr.argument, {
                precedence: Precedence.Unary,
                allowIn: true,
                allowCall: true
            });

            if (space === '') {
                result = join(expr.operator, fragment);
            } else {
                result = [expr.operator];
                if (expr.operator.length > 2) {
                    // delete, void, typeof
                    // get `typeof []`, not `typeof[]`
                    result = join(result, fragment);
                } else {
                    // Prevent inserting spaces between operator and argument if it is unnecessary
                    // like, `!cond`
                    leftSource = toSourceNode(result).toString();
                    leftChar = leftSource.charAt(leftSource.length - 1);
                    rightChar = fragment.toString().charAt(0);

                    if (((leftChar === '+' || leftChar === '-') && leftChar === rightChar) || (isIdentifierPart(leftChar) && isIdentifierPart(rightChar))) {
                        result.push(noEmptySpace(), fragment);
                    } else {
                        result.push(fragment);
                    }
                }
            }
            result = parenthesize(result, Precedence.Unary, precedence);
            break;

        case Syntax.YieldExpression:
            if (expr.delegate) {
                result = 'yield*';
            } else {
                result = 'yield';
            }
            if (expr.argument) {
                result = join(
                    result,
                    generateExpression(expr.argument, {
                        precedence: Precedence.Assignment,
                        allowIn: true,
                        allowCall: true
                    })
                );
            }
            break;

        case Syntax.UpdateExpression:
            if (expr.prefix) {
                result = parenthesize(
                    [
                        expr.operator,
                        generateExpression(expr.argument, {
                            precedence: Precedence.Unary,
                            allowIn: true,
                            allowCall: true
                        })
                    ],
                    Precedence.Unary,
                    precedence
                );
            } else {
                result = parenthesize(
                    [
                        generateExpression(expr.argument, {
                            precedence: Precedence.Postfix,
                            allowIn: true,
                            allowCall: true
                        }),
                        expr.operator
                    ],
                    Precedence.Postfix,
                    precedence
                );
            }
            break;

        case Syntax.FunctionExpression:
            result = 'function';

            if (expr.id) {
                result = [result, noEmptySpace(),
                          generateIdentifier(expr.id),
                          generateFunctionBody(expr)];
            } else {
                result = [result + space, generateFunctionBody(expr)];
            }

            break;

        case Syntax.ArrayPattern:
        case Syntax.ArrayExpression:
            if (!expr.elements.length) {
                result = '[]';
                break;
            }
            multiline = expr.elements.length > 1;
            result = ['[', multiline ? newline : ''];
            withIndent(function (indent) {
                for (i = 0, len = expr.elements.length; i < len; i += 1) {
                    if (!expr.elements[i]) {
                        if (multiline) {
                            result.push(indent);
                        }
                        if (i + 1 === len) {
                            result.push(',');
                        }
                    } else {
                        result.push(multiline ? indent : '', generateExpression(expr.elements[i], {
                            precedence: Precedence.Assignment,
                            allowIn: true,
                            allowCall: true
                        }));
                    }
                    if (i + 1 < len) {
                        result.push(',' + (multiline ? newline : space));
                    }
                }
            });
            if (multiline && !endsWithLineTerminator(toSourceNode(result).toString())) {
                result.push(newline);
            }
            result.push(multiline ? base : '', ']');
            break;

        case Syntax.Property:
            if (expr.kind === 'get' || expr.kind === 'set') {
                result = [
                    expr.kind, noEmptySpace(),
                    generateExpression(expr.key, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    generateFunctionBody(expr.value)
                ];
            } else {
                if (expr.shorthand) {
                    result = generateExpression(expr.key, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    });
                } else if (expr.method) {
                    result = [];
                    if (expr.value.generator) {
                        result.push('*');
                    }
                    result.push(generateExpression(expr.key, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }), generateFunctionBody(expr.value));
                } else {
                    result = [
                        generateExpression(expr.key, {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true
                        }),
                        ':' + space,
                        generateExpression(expr.value, {
                            precedence: Precedence.Assignment,
                            allowIn: true,
                            allowCall: true
                        })
                    ];
                }
            }
            break;

        case Syntax.ObjectExpression:
            if (!expr.properties.length) {
                result = '{}';
                break;
            }
            multiline = expr.properties.length > 1;

            withIndent(function () {
                fragment = generateExpression(expr.properties[0], {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true,
                    type: Syntax.Property
                });
            });

            if (!multiline) {
                // issues 4
                // Do not transform from
                //   dejavu.Class.declare({
                //       method2: function () {}
                //   });
                // to
                //   dejavu.Class.declare({method2: function () {
                //       }});
                if (!hasLineTerminator(toSourceNode(fragment).toString())) {
                    result = [ '{', space, fragment, space, '}' ];
                    break;
                }
            }

            withIndent(function (indent) {
                result = [ '{', newline, indent, fragment ];

                if (multiline) {
                    result.push(',' + newline);
                    for (i = 1, len = expr.properties.length; i < len; i += 1) {
                        result.push(indent, generateExpression(expr.properties[i], {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true,
                            type: Syntax.Property
                        }));
                        if (i + 1 < len) {
                            result.push(',' + newline);
                        }
                    }
                }
            });

            if (!endsWithLineTerminator(toSourceNode(result).toString())) {
                result.push(newline);
            }
            result.push(base, '}');
            break;

        case Syntax.ObjectPattern:
            if (!expr.properties.length) {
                result = '{}';
                break;
            }

            multiline = false;
            if (expr.properties.length === 1) {
                property = expr.properties[0];
                if (property.value.type !== Syntax.Identifier) {
                    multiline = true;
                }
            } else {
                for (i = 0, len = expr.properties.length; i < len; i += 1) {
                    property = expr.properties[i];
                    if (!property.shorthand) {
                        multiline = true;
                        break;
                    }
                }
            }
            result = ['{', multiline ? newline : '' ];

            withIndent(function (indent) {
                for (i = 0, len = expr.properties.length; i < len; i += 1) {
                    result.push(multiline ? indent : '', generateExpression(expr.properties[i], {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }));
                    if (i + 1 < len) {
                        result.push(',' + (multiline ? newline : space));
                    }
                }
            });

            if (multiline && !endsWithLineTerminator(toSourceNode(result).toString())) {
                result.push(newline);
            }
            result.push(multiline ? base : '', '}');
            break;

        case Syntax.ThisExpression:
            result = 'this';
            break;

        case Syntax.Identifier:
            result = generateIdentifier(expr);
            break;

        case Syntax.Literal:
            if (expr.hasOwnProperty('raw') && parse) {
                try {
                    raw = parse(expr.raw).body[0].expression;
                    if (raw.type === Syntax.Literal) {
                        if (raw.value === expr.value) {
                            result = expr.raw;
                            break;
                        }
                    }
                } catch (e) {
                    // not use raw property
                }
            }

            if (expr.value === null) {
                result = 'null';
                break;
            }

            if (typeof expr.value === 'string') {
                result = escapeString(expr.value);
                break;
            }

            if (typeof expr.value === 'number') {
                result = generateNumber(expr.value);
                break;
            }

            if (typeof expr.value === 'boolean') {
                result = expr.value ? 'true' : 'false';
                break;
            }

            result = generateRegExp(expr.value);
            break;

        case Syntax.ComprehensionExpression:
            result = [
                '[',
                generateExpression(expr.body, {
                    precedence: Precedence.Assignment,
                    allowIn: true,
                    allowCall: true
                })
            ];

            if (expr.blocks) {
                for (i = 0, len = expr.blocks.length; i < len; i += 1) {
                    fragment = generateExpression(expr.blocks[i], {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    });
                    result = join(result, fragment);
                }
            }

            if (expr.filter) {
                result = join(result, 'if' + space);
                fragment = generateExpression(expr.filter, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                });
                if (extra.moz.parenthesizedComprehensionBlock) {
                    result = join(result, [ '(', fragment, ')' ]);
                } else {
                    result = join(result, fragment);
                }
            }
            result.push(']');
            break;

        case Syntax.ComprehensionBlock:
            if (expr.left.type === Syntax.VariableDeclaration) {
                fragment = [
                    expr.left.kind, noEmptySpace(),
                    generateStatement(expr.left.declarations[0], {
                        allowIn: false
                    })
                ];
            } else {
                fragment = generateExpression(expr.left, {
                    precedence: Precedence.Call,
                    allowIn: true,
                    allowCall: true
                });
            }

            fragment = join(fragment, expr.of ? 'of' : 'in');
            fragment = join(fragment, generateExpression(expr.right, {
                precedence: Precedence.Sequence,
                allowIn: true,
                allowCall: true
            }));

            if (extra.moz.parenthesizedComprehensionBlock) {
                result = [ 'for' + space + '(', fragment, ')' ];
            } else {
                result = join('for' + space, fragment);
            }
            break;

        default:
            throw new Error('Unknown expression type: ' + expr.type);
        }

        return toSourceNode(result, expr);
    }

    function generateStatement(stmt, option) {
        var i, len, result, node, allowIn, functionBody, directiveContext, fragment, semicolon;

        allowIn = true;
        semicolon = ';';
        functionBody = false;
        directiveContext = false;
        if (option) {
            allowIn = option.allowIn === undefined || option.allowIn;
            if (!semicolons && option.semicolonOptional === true) {
                semicolon = '';
            }
            functionBody = option.functionBody;
            directiveContext = option.directiveContext;
        }

        switch (stmt.type) {
        case Syntax.BlockStatement:
            result = ['{', newline];

            withIndent(function () {
                for (i = 0, len = stmt.body.length; i < len; i += 1) {
                    fragment = addIndent(generateStatement(stmt.body[i], {
                        semicolonOptional: i === len - 1,
                        directiveContext: functionBody
                    }));
                    result.push(fragment);
                    if (!endsWithLineTerminator(toSourceNode(fragment).toString())) {
                        result.push(newline);
                    }
                }
            });

            result.push(addIndent('}'));
            break;

        case Syntax.BreakStatement:
            if (stmt.label) {
                result = 'break ' + stmt.label.name + semicolon;
            } else {
                result = 'break' + semicolon;
            }
            break;

        case Syntax.ContinueStatement:
            if (stmt.label) {
                result = 'continue ' + stmt.label.name + semicolon;
            } else {
                result = 'continue' + semicolon;
            }
            break;

        case Syntax.DirectiveStatement:
            if (stmt.raw) {
                result = stmt.raw + semicolon;
            } else {
                result = escapeDirective(stmt.directive) + semicolon;
            }
            break;

        case Syntax.DoWhileStatement:
            // Because `do 42 while (cond)` is Syntax Error. We need semicolon.
            result = join('do', maybeBlock(stmt.body));
            result = maybeBlockSuffix(stmt.body, result);
            result = join(result, [
                'while' + space + '(',
                generateExpression(stmt.test, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                }),
                ')' + semicolon
            ]);
            break;

        case Syntax.CatchClause:
            withIndent(function () {
                result = [
                    'catch' + space + '(',
                    generateExpression(stmt.param, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            result.push(maybeBlock(stmt.body));
            break;

        case Syntax.DebuggerStatement:
            result = 'debugger' + semicolon;
            break;

        case Syntax.EmptyStatement:
            result = ';';
            break;

        case Syntax.ExpressionStatement:
            result = [generateExpression(stmt.expression, {
                precedence: Precedence.Sequence,
                allowIn: true,
                allowCall: true
            })];
            // 12.4 '{', 'function' is not allowed in this position.
            // wrap expression with parentheses
            fragment = toSourceNode(result).toString();
            if (fragment.charAt(0) === '{' || (fragment.slice(0, 8) === 'function' && ' ('.indexOf(fragment.charAt(8)) >= 0) || (directive && directiveContext && stmt.expression.type === Syntax.Literal && typeof stmt.expression.value === 'string')) {
                result = ['(', result, ')' + semicolon];
            } else {
                result.push(semicolon);
            }
            break;

        case Syntax.VariableDeclarator:
            if (stmt.init) {
                result = [
                    generateExpression(stmt.id, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    }),
                    space,
                    '=',
                    space,
                    generateExpression(stmt.init, {
                        precedence: Precedence.Assignment,
                        allowIn: allowIn,
                        allowCall: true
                    })
                ];
            } else {
                result = generateIdentifier(stmt.id);
            }
            break;

        case Syntax.VariableDeclaration:
            result = [stmt.kind];
            // special path for
            // var x = function () {
            // };
            if (stmt.declarations.length === 1 && stmt.declarations[0].init &&
                    stmt.declarations[0].init.type === Syntax.FunctionExpression) {
                result.push(noEmptySpace(), generateStatement(stmt.declarations[0], {
                    allowIn: allowIn
                }));
            } else {
                // VariableDeclarator is typed as Statement,
                // but joined with comma (not LineTerminator).
                // So if comment is attached to target node, we should specialize.
                withIndent(function () {
                    node = stmt.declarations[0];
                    if (extra.comment && node.leadingComments) {
                        result.push('\n', addIndent(generateStatement(node, {
                            allowIn: allowIn
                        })));
                    } else {
                        result.push(noEmptySpace(), generateStatement(node, {
                            allowIn: allowIn
                        }));
                    }

                    for (i = 1, len = stmt.declarations.length; i < len; i += 1) {
                        node = stmt.declarations[i];
                        if (extra.comment && node.leadingComments) {
                            result.push(',' + newline, addIndent(generateStatement(node, {
                                allowIn: allowIn
                            })));
                        } else {
                            result.push(',' + space, generateStatement(node, {
                                allowIn: allowIn
                            }));
                        }
                    }
                });
            }
            result.push(semicolon);
            break;

        case Syntax.ThrowStatement:
            result = [join(
                'throw',
                generateExpression(stmt.argument, {
                    precedence: Precedence.Sequence,
                    allowIn: true,
                    allowCall: true
                })
            ), semicolon];
            break;

        case Syntax.TryStatement:
            result = ['try', maybeBlock(stmt.block)];
            result = maybeBlockSuffix(stmt.block, result);
            if (stmt.handlers) {
                // old interface
                for (i = 0, len = stmt.handlers.length; i < len; i += 1) {
                    result = join(result, generateStatement(stmt.handlers[i]));
                    if (stmt.finalizer || i + 1 !== len) {
                        result = maybeBlockSuffix(stmt.handlers[i].body, result);
                    }
                }
            } else {
                // new interface
                if (stmt.handler) {
                    result = join(result, generateStatement(stmt.handler));
                    if (stmt.finalizer || stmt.guardedHandlers.length > 0) {
                        result = maybeBlockSuffix(stmt.handler.body, result);
                    }
                }

                for (i = 0, len = stmt.guardedHandlers.length; i < len; i += 1) {
                    result = join(result, generateStatement(stmt.guardedHandlers[i]));
                    if (stmt.finalizer || i + 1 !== len) {
                        result = maybeBlockSuffix(stmt.guardedHandlers[i].body, result);
                    }
                }
            }
            if (stmt.finalizer) {
                result = join(result, ['finally', maybeBlock(stmt.finalizer)]);
            }
            break;

        case Syntax.SwitchStatement:
            withIndent(function () {
                result = [
                    'switch' + space + '(',
                    generateExpression(stmt.discriminant, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')' + space + '{' + newline
                ];
            });
            if (stmt.cases) {
                for (i = 0, len = stmt.cases.length; i < len; i += 1) {
                    fragment = addIndent(generateStatement(stmt.cases[i], {semicolonOptional: i === len - 1}));
                    result.push(fragment);
                    if (!endsWithLineTerminator(toSourceNode(fragment).toString())) {
                        result.push(newline);
                    }
                }
            }
            result.push(addIndent('}'));
            break;

        case Syntax.SwitchCase:
            withIndent(function () {
                if (stmt.test) {
                    result = [
                        join('case', generateExpression(stmt.test, {
                            precedence: Precedence.Sequence,
                            allowIn: true,
                            allowCall: true
                        })),
                        ':'
                    ];
                } else {
                    result = ['default:'];
                }

                i = 0;
                len = stmt.consequent.length;
                if (len && stmt.consequent[0].type === Syntax.BlockStatement) {
                    fragment = maybeBlock(stmt.consequent[0]);
                    result.push(fragment);
                    i = 1;
                }

                if (i !== len && !endsWithLineTerminator(toSourceNode(result).toString())) {
                    result.push(newline);
                }

                for (; i < len; i += 1) {
                    fragment = addIndent(generateStatement(stmt.consequent[i], {semicolonOptional: i === len - 1 && semicolon === ''}));
                    result.push(fragment);
                    if (i + 1 !== len && !endsWithLineTerminator(toSourceNode(fragment).toString())) {
                        result.push(newline);
                    }
                }
            });
            break;

        case Syntax.IfStatement:
            withIndent(function () {
                result = [
                    'if' + space + '(',
                    generateExpression(stmt.test, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            if (stmt.alternate) {
                result.push(maybeBlock(stmt.consequent));
                result = maybeBlockSuffix(stmt.consequent, result);
                if (stmt.alternate.type === Syntax.IfStatement) {
                    result = join(result, ['else ', generateStatement(stmt.alternate, {semicolonOptional: semicolon === ''})]);
                } else {
                    result = join(result, join('else', maybeBlock(stmt.alternate, semicolon === '')));
                }
            } else {
                result.push(maybeBlock(stmt.consequent, semicolon === ''));
            }
            break;

        case Syntax.ForStatement:
            withIndent(function () {
                result = ['for' + space + '('];
                if (stmt.init) {
                    if (stmt.init.type === Syntax.VariableDeclaration) {
                        result.push(generateStatement(stmt.init, {allowIn: false}));
                    } else {
                        result.push(generateExpression(stmt.init, {
                            precedence: Precedence.Sequence,
                            allowIn: false,
                            allowCall: true
                        }), ';');
                    }
                } else {
                    result.push(';');
                }

                if (stmt.test) {
                    result.push(space, generateExpression(stmt.test, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }), ';');
                } else {
                    result.push(';');
                }

                if (stmt.update) {
                    result.push(space, generateExpression(stmt.update, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }), ')');
                } else {
                    result.push(')');
                }
            });

            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        case Syntax.ForInStatement:
            result = ['for' + space + '('];
            withIndent(function () {
                if (stmt.left.type === Syntax.VariableDeclaration) {
                    withIndent(function () {
                        result.push(stmt.left.kind + noEmptySpace(), generateStatement(stmt.left.declarations[0], {
                            allowIn: false
                        }));
                    });
                } else {
                    result.push(generateExpression(stmt.left, {
                        precedence: Precedence.Call,
                        allowIn: true,
                        allowCall: true
                    }));
                }

                result = join(result, 'in');
                result = [join(
                    result,
                    generateExpression(stmt.right, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    })
                ), ')'];
            });
            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        case Syntax.LabeledStatement:
            result = [stmt.label.name + ':', maybeBlock(stmt.body, semicolon === '')];
            break;

        case Syntax.Program:
            len = stmt.body.length;
            result = [safeConcatenation && len > 0 ? '\n' : ''];
            for (i = 0; i < len; i += 1) {
                fragment = addIndent(
                    generateStatement(stmt.body[i], {
                        semicolonOptional: !safeConcatenation && i === len - 1,
                        directiveContext: true
                    })
                );
                result.push(fragment);
                if (i + 1 < len && !endsWithLineTerminator(toSourceNode(fragment).toString())) {
                    result.push(newline);
                }
            }
            break;

        case Syntax.FunctionDeclaration:
            result = [(stmt.generator && !extra.moz.starlessGenerator ? 'function* ' : 'function '),
                      generateIdentifier(stmt.id),
                      generateFunctionBody(stmt)];
            break;

        case Syntax.ReturnStatement:
            if (stmt.argument) {
                result = [join(
                    'return',
                    generateExpression(stmt.argument, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    })
                ), semicolon];
            } else {
                result = ['return' + semicolon];
            }
            break;

        case Syntax.WhileStatement:
            withIndent(function () {
                result = [
                    'while' + space + '(',
                    generateExpression(stmt.test, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        case Syntax.WithStatement:
            withIndent(function () {
                result = [
                    'with' + space + '(',
                    generateExpression(stmt.object, {
                        precedence: Precedence.Sequence,
                        allowIn: true,
                        allowCall: true
                    }),
                    ')'
                ];
            });
            result.push(maybeBlock(stmt.body, semicolon === ''));
            break;

        default:
            throw new Error('Unknown statement type: ' + stmt.type);
        }

        // Attach comments

        if (extra.comment) {
            result = addCommentsToStatement(stmt, result);
        }

        fragment = toSourceNode(result).toString();
        if (stmt.type === Syntax.Program && !safeConcatenation && newline === '' &&  fragment.charAt(fragment.length - 1) === '\n') {
            result = toSourceNode(result).replaceRight(/\s+$/, '');
        }

        return toSourceNode(result, stmt);
    }

    function generate(node, options) {
        var defaultOptions = getDefaultOptions(), result, pair;

        if (options != null) {
            // Obsolete options
            //
            //   `options.indent`
            //   `options.base`
            //
            // Instead of them, we can use `option.format.indent`.
            if (typeof options.indent === 'string') {
                defaultOptions.format.indent.style = options.indent;
            }
            if (typeof options.base === 'number') {
                defaultOptions.format.indent.base = options.base;
            }
            options = updateDeeply(defaultOptions, options);
            indent = options.format.indent.style;
            if (typeof options.base === 'string') {
                base = options.base;
            } else {
                base = stringRepeat(indent, options.format.indent.base);
            }
        } else {
            options = defaultOptions;
            indent = options.format.indent.style;
            base = stringRepeat(indent, options.format.indent.base);
        }
        json = options.format.json;
        renumber = options.format.renumber;
        hexadecimal = json ? false : options.format.hexadecimal;
        quotes = json ? 'double' : options.format.quotes;
        escapeless = options.format.escapeless;
        newline = options.format.newline;
        space = options.format.space;
        if (options.format.compact) {
            newline = space = indent = base = '';
        }
        parentheses = options.format.parentheses;
        semicolons = options.format.semicolons;
        safeConcatenation = options.format.safeConcatenation;
        directive = options.directive;
        parse = json ? null : options.parse;
        sourceMap = options.sourceMap;
        extra = options;

        if (sourceMap) {
            if (!exports.browser) {
                // We assume environment is node.js
                // And prevent from including source-map by browserify
                SourceNode = require('source-map').SourceNode;
            } else {
                SourceNode = global.sourceMap.SourceNode;
            }
        } else {
            SourceNode = SourceNodeMock;
        }

        switch (node.type) {
        case Syntax.BlockStatement:
        case Syntax.BreakStatement:
        case Syntax.CatchClause:
        case Syntax.ContinueStatement:
        case Syntax.DirectiveStatement:
        case Syntax.DoWhileStatement:
        case Syntax.DebuggerStatement:
        case Syntax.EmptyStatement:
        case Syntax.ExpressionStatement:
        case Syntax.ForStatement:
        case Syntax.ForInStatement:
        case Syntax.FunctionDeclaration:
        case Syntax.IfStatement:
        case Syntax.LabeledStatement:
        case Syntax.Program:
        case Syntax.ReturnStatement:
        case Syntax.SwitchStatement:
        case Syntax.SwitchCase:
        case Syntax.ThrowStatement:
        case Syntax.TryStatement:
        case Syntax.VariableDeclaration:
        case Syntax.VariableDeclarator:
        case Syntax.WhileStatement:
        case Syntax.WithStatement:
            result = generateStatement(node);
            break;

        case Syntax.AssignmentExpression:
        case Syntax.ArrayExpression:
        case Syntax.ArrayPattern:
        case Syntax.BinaryExpression:
        case Syntax.CallExpression:
        case Syntax.ConditionalExpression:
        case Syntax.FunctionExpression:
        case Syntax.Identifier:
        case Syntax.Literal:
        case Syntax.LogicalExpression:
        case Syntax.MemberExpression:
        case Syntax.NewExpression:
        case Syntax.ObjectExpression:
        case Syntax.ObjectPattern:
        case Syntax.Property:
        case Syntax.SequenceExpression:
        case Syntax.ThisExpression:
        case Syntax.UnaryExpression:
        case Syntax.UpdateExpression:
        case Syntax.YieldExpression:

            result = generateExpression(node, {
                precedence: Precedence.Sequence,
                allowIn: true,
                allowCall: true
            });
            break;

        default:
            throw new Error('Unknown node type: ' + node.type);
        }

        if (!sourceMap) {
            return result.toString();
        }

        pair = result.toStringWithSourceMap({
            file: options.file,
            sourceRoot: options.sourceMapRoot
        });

        if (options.sourceMapWithCode) {
            return pair;
        }
        return pair.map.toString();
    }

    FORMAT_MINIFY = {
        indent: {
            style: '',
            base: 0
        },
        renumber: true,
        hexadecimal: true,
        quotes: 'auto',
        escapeless: true,
        compact: true,
        parentheses: false,
        semicolons: false
    };

    FORMAT_DEFAULTS = getDefaultOptions().format;

    exports.version = require('./package.json').version;
    exports.generate = generate;
    exports.attachComments = estraverse.attachComments;
    exports.browser = false;
    exports.FORMAT_MINIFY = FORMAT_MINIFY;
    exports.FORMAT_DEFAULTS = FORMAT_DEFAULTS;
}());
/* vim: set sw=4 ts=4 et tw=80 : */

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./package.json":40,"estraverse":42,"source-map":30}],30:[function(require,module,exports){
arguments[4][15][0].apply(exports,arguments)
},{"./source-map/source-map-consumer":35,"./source-map/source-map-generator":36,"./source-map/source-node":37,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map.js":15}],31:[function(require,module,exports){
arguments[4][16][0].apply(exports,arguments)
},{"./util":38,"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\array-set.js":16}],32:[function(require,module,exports){
arguments[4][17][0].apply(exports,arguments)
},{"./base64":33,"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\base64-vlq.js":17}],33:[function(require,module,exports){
arguments[4][18][0].apply(exports,arguments)
},{"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\base64.js":18}],34:[function(require,module,exports){
arguments[4][19][0].apply(exports,arguments)
},{"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\binary-search.js":19}],35:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"./array-set":31,"./base64-vlq":32,"./binary-search":34,"./util":38,"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\source-map-consumer.js":20}],36:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"./array-set":31,"./base64-vlq":32,"./util":38,"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\source-map-generator.js":21}],37:[function(require,module,exports){
arguments[4][22][0].apply(exports,arguments)
},{"./source-map-generator":36,"./util":38,"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\source-node.js":22}],38:[function(require,module,exports){
arguments[4][23][0].apply(exports,arguments)
},{"amdefine":39,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\escodegen\\node_modules\\source-map\\lib\\source-map\\util.js":23}],39:[function(require,module,exports){
(function (process,__filename){
/** vim: et:ts=4:sw=4:sts=4
 * @license amdefine 0.1.0 Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/amdefine for details
 */

/*jslint node: true */
/*global module, process */
'use strict';

/**
 * Creates a define for node.
 * @param {Object} module the "module" object that is defined by Node for the
 * current module.
 * @param {Function} [requireFn]. Node's require function for the current module.
 * It only needs to be passed in Node versions before 0.5, when module.require
 * did not exist.
 * @returns {Function} a define function that is usable for the current node
 * module.
 */
function amdefine(module, requireFn) {
    'use strict';
    var defineCache = {},
        loaderCache = {},
        alreadyCalled = false,
        path = require('path'),
        makeRequire, stringRequire;

    /**
     * Trims the . and .. from an array of path segments.
     * It will keep a leading path segment if a .. will become
     * the first path segment, to help with module name lookups,
     * which act like paths, but can be remapped. But the end result,
     * all paths that use this function should look normalized.
     * NOTE: this method MODIFIES the input array.
     * @param {Array} ary the array of path segments.
     */
    function trimDots(ary) {
        var i, part;
        for (i = 0; ary[i]; i+= 1) {
            part = ary[i];
            if (part === '.') {
                ary.splice(i, 1);
                i -= 1;
            } else if (part === '..') {
                if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
                    //End of the line. Keep at least one non-dot
                    //path segment at the front so it can be mapped
                    //correctly to disk. Otherwise, there is likely
                    //no path mapping for a path starting with '..'.
                    //This can still fail, but catches the most reasonable
                    //uses of ..
                    break;
                } else if (i > 0) {
                    ary.splice(i - 1, 2);
                    i -= 2;
                }
            }
        }
    }

    function normalize(name, baseName) {
        var baseParts;

        //Adjust any relative paths.
        if (name && name.charAt(0) === '.') {
            //If have a base name, try to normalize against it,
            //otherwise, assume it is a top-level require that will
            //be relative to baseUrl in the end.
            if (baseName) {
                baseParts = baseName.split('/');
                baseParts = baseParts.slice(0, baseParts.length - 1);
                baseParts = baseParts.concat(name.split('/'));
                trimDots(baseParts);
                name = baseParts.join('/');
            }
        }

        return name;
    }

    /**
     * Create the normalize() function passed to a loader plugin's
     * normalize method.
     */
    function makeNormalize(relName) {
        return function (name) {
            return normalize(name, relName);
        };
    }

    function makeLoad(id) {
        function load(value) {
            loaderCache[id] = value;
        }

        load.fromText = function (id, text) {
            //This one is difficult because the text can/probably uses
            //define, and any relative paths and requires should be relative
            //to that id was it would be found on disk. But this would require
            //bootstrapping a module/require fairly deeply from node core.
            //Not sure how best to go about that yet.
            throw new Error('amdefine does not implement load.fromText');
        };

        return load;
    }

    makeRequire = function (systemRequire, exports, module, relId) {
        function amdRequire(deps, callback) {
            if (typeof deps === 'string') {
                //Synchronous, single module require('')
                return stringRequire(systemRequire, exports, module, deps, relId);
            } else {
                //Array of dependencies with a callback.

                //Convert the dependencies to modules.
                deps = deps.map(function (depName) {
                    return stringRequire(systemRequire, exports, module, depName, relId);
                });

                //Wait for next tick to call back the require call.
                process.nextTick(function () {
                    callback.apply(null, deps);
                });
            }
        }

        amdRequire.toUrl = function (filePath) {
            if (filePath.indexOf('.') === 0) {
                return normalize(filePath, path.dirname(module.filename));
            } else {
                return filePath;
            }
        };

        return amdRequire;
    };

    //Favor explicit value, passed in if the module wants to support Node 0.4.
    requireFn = requireFn || function req() {
        return module.require.apply(module, arguments);
    };

    function runFactory(id, deps, factory) {
        var r, e, m, result;

        if (id) {
            e = loaderCache[id] = {};
            m = {
                id: id,
                uri: __filename,
                exports: e
            };
            r = makeRequire(requireFn, e, m, id);
        } else {
            //Only support one define call per file
            if (alreadyCalled) {
                throw new Error('amdefine with no module ID cannot be called more than once per file.');
            }
            alreadyCalled = true;

            //Use the real variables from node
            //Use module.exports for exports, since
            //the exports in here is amdefine exports.
            e = module.exports;
            m = module;
            r = makeRequire(requireFn, e, m, module.id);
        }

        //If there are dependencies, they are strings, so need
        //to convert them to dependency values.
        if (deps) {
            deps = deps.map(function (depName) {
                return r(depName);
            });
        }

        //Call the factory with the right dependencies.
        if (typeof factory === 'function') {
            result = factory.apply(m.exports, deps);
        } else {
            result = factory;
        }

        if (result !== undefined) {
            m.exports = result;
            if (id) {
                loaderCache[id] = m.exports;
            }
        }
    }

    stringRequire = function (systemRequire, exports, module, id, relId) {
        //Split the ID by a ! so that
        var index = id.indexOf('!'),
            originalId = id,
            prefix, plugin;

        if (index === -1) {
            id = normalize(id, relId);

            //Straight module lookup. If it is one of the special dependencies,
            //deal with it, otherwise, delegate to node.
            if (id === 'require') {
                return makeRequire(systemRequire, exports, module, relId);
            } else if (id === 'exports') {
                return exports;
            } else if (id === 'module') {
                return module;
            } else if (loaderCache.hasOwnProperty(id)) {
                return loaderCache[id];
            } else if (defineCache[id]) {
                runFactory.apply(null, defineCache[id]);
                return loaderCache[id];
            } else {
                if(systemRequire) {
                    return systemRequire(originalId);
                } else {
                    throw new Error('No module with ID: ' + id);
                }
            }
        } else {
            //There is a plugin in play.
            prefix = id.substring(0, index);
            id = id.substring(index + 1, id.length);

            plugin = stringRequire(systemRequire, exports, module, prefix, relId);

            if (plugin.normalize) {
                id = plugin.normalize(id, makeNormalize(relId));
            } else {
                //Normalize the ID normally.
                id = normalize(id, relId);
            }

            if (loaderCache[id]) {
                return loaderCache[id];
            } else {
                plugin.load(id, makeRequire(systemRequire, exports, module, relId), makeLoad(id), {});

                return loaderCache[id];
            }
        }
    };

    //Create a define function specific to the module asking for amdefine.
    function define(id, deps, factory) {
        if (Array.isArray(id)) {
            factory = deps;
            deps = id;
            id = undefined;
        } else if (typeof id !== 'string') {
            factory = id;
            id = deps = undefined;
        }

        if (deps && !Array.isArray(deps)) {
            factory = deps;
            deps = undefined;
        }

        if (!deps) {
            deps = ['require', 'exports', 'module'];
        }

        //Set up properties for this module. If an ID, then use
        //internal cache. If no ID, then use the external variables
        //for this node module.
        if (id) {
            //Put the module in deep freeze until there is a
            //require call for it.
            defineCache[id] = [id, deps, factory];
        } else {
            runFactory(id, deps, factory);
        }
    }

    //define.require, which has access to all the values in the
    //cache. Useful for AMD modules that all have IDs in the file,
    //but need to finally export a value to node based on one of those
    //IDs.
    define.require = function (id) {
        if (loaderCache[id]) {
            return loaderCache[id];
        }

        if (defineCache[id]) {
            runFactory.apply(null, defineCache[id]);
            return loaderCache[id];
        }
    };

    define.amd = {};

    return define;
}

module.exports = amdefine;

}).call(this,require('_process'),"/node_modules\\esgraph\\node_modules\\escodegen\\node_modules\\source-map\\node_modules\\amdefine\\amdefine.js")
},{"_process":46,"path":45}],40:[function(require,module,exports){
module.exports={
  "name": "escodegen",
  "description": "ECMAScript code generator",
  "homepage": "http://github.com/Constellation/escodegen.html",
  "main": "escodegen.js",
  "bin": {
    "esgenerate": "./bin/esgenerate.js",
    "escodegen": "./bin/escodegen.js"
  },
  "version": "0.0.28",
  "engines": {
    "node": ">=0.4.0"
  },
  "maintainers": [
    {
      "name": "Yusuke Suzuki",
      "email": "utatane.tea@gmail.com",
      "url": "http://github.com/Constellation"
    }
  ],
  "repository": {
    "type": "git",
    "url": "http://github.com/Constellation/escodegen.git"
  },
  "dependencies": {
    "esprima": "~1.0.2",
    "estraverse": "~1.3.0",
    "source-map": ">= 0.1.2"
  },
  "optionalDependencies": {
    "source-map": ">= 0.1.2"
  },
  "devDependencies": {
    "esprima-moz": "*",
    "commonjs-everywhere": "~0.8.0",
    "q": "*",
    "bower": "*",
    "semver": "*",
    "chai": "~1.7.2",
    "grunt-contrib-jshint": "~0.5.0",
    "grunt-cli": "~0.1.9",
    "grunt": "~0.4.1",
    "grunt-mocha-test": "~0.6.2"
  },
  "licenses": [
    {
      "type": "BSD",
      "url": "http://github.com/Constellation/escodegen/raw/master/LICENSE.BSD"
    }
  ],
  "scripts": {
    "test": "grunt travis",
    "unit-test": "grunt test",
    "lint": "grunt lint",
    "release": "node tools/release.js",
    "build-min": "cjsify -ma path: tools/entry-point.js > escodegen.browser.min.js",
    "build": "cjsify -a path: tools/entry-point.js > escodegen.browser.js"
  },
  "readme": "\n### Escodegen [![Build Status](https://secure.travis-ci.org/Constellation/escodegen.png)](http://travis-ci.org/Constellation/escodegen) [![Build Status](https://drone.io/github.com/Constellation/escodegen/status.png)](https://drone.io/github.com/Constellation/escodegen/latest)\n\nEscodegen ([escodegen](http://github.com/Constellation/escodegen)) is\n[ECMAScript](http://www.ecma-international.org/publications/standards/Ecma-262.htm)\n(also popularly known as [JavaScript](http://en.wikipedia.org/wiki/JavaScript>JavaScript))\ncode generator from [Parser API](https://developer.mozilla.org/en/SpiderMonkey/Parser_API) AST.\nSee [online generator demo](http://constellation.github.com/escodegen/demo/index.html).\n\n\n### Install\n\nEscodegen can be used in a web browser:\n\n    <script src=\"escodegen.browser.js\"></script>\n\nescodegen.browser.js is found in tagged-revision. See Tags on GitHub.\n\nOr in a Node.js application via the package manager:\n\n    npm install escodegen\n\n### Usage\n\nA simple example: the program\n\n    escodegen.generate({\n        type: 'BinaryExpression',\n        operator: '+',\n        left: { type: 'Literal', value: 40 },\n        right: { type: 'Literal', value: 2 }\n    });\n\nproduces the string `'40 + 2'`\n\nSee the [API page](https://github.com/Constellation/escodegen/wiki/API) for\noptions. To run the tests, execute `npm test` in the root directory.\n\n### License\n\n#### Escodegen\n\nCopyright (C) 2012 [Yusuke Suzuki](http://github.com/Constellation)\n (twitter: [@Constellation](http://twitter.com/Constellation)) and other contributors.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n  * Redistributions of source code must retain the above copyright\n    notice, this list of conditions and the following disclaimer.\n\n  * Redistributions in binary form must reproduce the above copyright\n    notice, this list of conditions and the following disclaimer in the\n    documentation and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\"\nAND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE\nIMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE\nARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY\nDIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES\n(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;\nLOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND\nON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT\n(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF\nTHIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n\n#### source-map\n\nSourceNodeMocks has a limited interface of mozilla/source-map SourceNode implementations.\n\nCopyright (c) 2009-2011, Mozilla Foundation and contributors\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n* Redistributions of source code must retain the above copyright notice, this\n  list of conditions and the following disclaimer.\n\n* Redistributions in binary form must reproduce the above copyright notice,\n  this list of conditions and the following disclaimer in the documentation\n  and/or other materials provided with the distribution.\n\n* Neither the names of the Mozilla Foundation nor the names of project\n  contributors may be used to endorse or promote products derived from this\n  software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND\nANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED\nWARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\nDISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE\nFOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL\nDAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\nSERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER\nCAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,\nOR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n",
  "readmeFilename": "README.md",
  "bugs": {
    "url": "https://github.com/Constellation/escodegen/issues"
  },
  "_id": "escodegen@0.0.28",
  "_from": "escodegen@~ 0.0.27"
}

},{}],41:[function(require,module,exports){
/*
  Copyright (C) 2012 Ariya Hidayat <ariya.hidayat@gmail.com>
  Copyright (C) 2012 Mathias Bynens <mathias@qiwi.be>
  Copyright (C) 2012 Joost-Wim Boekesteijn <joost-wim@boekesteijn.nl>
  Copyright (C) 2012 Kris Kowal <kris.kowal@cixar.com>
  Copyright (C) 2012 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012 Arpad Borsos <arpad.borsos@googlemail.com>
  Copyright (C) 2011 Ariya Hidayat <ariya.hidayat@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*jslint bitwise:true plusplus:true */
/*global esprima:true, define:true, exports:true, window: true,
throwError: true, createLiteral: true, generateStatement: true,
parseAssignmentExpression: true, parseBlock: true, parseExpression: true,
parseFunctionDeclaration: true, parseFunctionExpression: true,
parseFunctionSourceElements: true, parseVariableIdentifier: true,
parseLeftHandSideExpression: true,
parseStatement: true, parseSourceElement: true */

(function (root, factory) {
    'use strict';

    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js,
    // Rhino, and plain browser loading.
    if (typeof define === 'function' && define.amd) {
        define(['exports'], factory);
    } else if (typeof exports !== 'undefined') {
        factory(exports);
    } else {
        factory((root.esprima = {}));
    }
}(this, function (exports) {
    'use strict';

    var Token,
        TokenName,
        Syntax,
        PropertyKind,
        Messages,
        Regex,
        source,
        strict,
        index,
        lineNumber,
        lineStart,
        length,
        buffer,
        state,
        extra;

    Token = {
        BooleanLiteral: 1,
        EOF: 2,
        Identifier: 3,
        Keyword: 4,
        NullLiteral: 5,
        NumericLiteral: 6,
        Punctuator: 7,
        StringLiteral: 8
    };

    TokenName = {};
    TokenName[Token.BooleanLiteral] = 'Boolean';
    TokenName[Token.EOF] = '<end>';
    TokenName[Token.Identifier] = 'Identifier';
    TokenName[Token.Keyword] = 'Keyword';
    TokenName[Token.NullLiteral] = 'Null';
    TokenName[Token.NumericLiteral] = 'Numeric';
    TokenName[Token.Punctuator] = 'Punctuator';
    TokenName[Token.StringLiteral] = 'String';

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        ArrayExpression: 'ArrayExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DoWhileStatement: 'DoWhileStatement',
        DebuggerStatement: 'DebuggerStatement',
        EmptyStatement: 'EmptyStatement',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForInStatement: 'ForInStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        Program: 'Program',
        Property: 'Property',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SwitchStatement: 'SwitchStatement',
        SwitchCase: 'SwitchCase',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement'
    };

    PropertyKind = {
        Data: 1,
        Get: 2,
        Set: 4
    };

    // Error messages should be identical to V8.
    Messages = {
        UnexpectedToken:  'Unexpected token %0',
        UnexpectedNumber:  'Unexpected number',
        UnexpectedString:  'Unexpected string',
        UnexpectedIdentifier:  'Unexpected identifier',
        UnexpectedReserved:  'Unexpected reserved word',
        UnexpectedEOS:  'Unexpected end of input',
        NewlineAfterThrow:  'Illegal newline after throw',
        InvalidRegExp: 'Invalid regular expression',
        UnterminatedRegExp:  'Invalid regular expression: missing /',
        InvalidLHSInAssignment:  'Invalid left-hand side in assignment',
        InvalidLHSInForIn:  'Invalid left-hand side in for-in',
        MultipleDefaultsInSwitch: 'More than one default clause in switch statement',
        NoCatchOrFinally:  'Missing catch or finally after try',
        UnknownLabel: 'Undefined label \'%0\'',
        Redeclaration: '%0 \'%1\' has already been declared',
        IllegalContinue: 'Illegal continue statement',
        IllegalBreak: 'Illegal break statement',
        IllegalReturn: 'Illegal return statement',
        StrictModeWith:  'Strict mode code may not include a with statement',
        StrictCatchVariable:  'Catch variable may not be eval or arguments in strict mode',
        StrictVarName:  'Variable name may not be eval or arguments in strict mode',
        StrictParamName:  'Parameter name eval or arguments is not allowed in strict mode',
        StrictParamDupe: 'Strict mode function may not have duplicate parameter names',
        StrictFunctionName:  'Function name may not be eval or arguments in strict mode',
        StrictOctalLiteral:  'Octal literals are not allowed in strict mode.',
        StrictDelete:  'Delete of an unqualified identifier in strict mode.',
        StrictDuplicateProperty:  'Duplicate data property in object literal not allowed in strict mode',
        AccessorDataProperty:  'Object literal may not have data and accessor property with the same name',
        AccessorGetSet:  'Object literal may not have multiple get/set accessors with the same name',
        StrictLHSAssignment:  'Assignment to eval or arguments is not allowed in strict mode',
        StrictLHSPostfix:  'Postfix increment/decrement may not have eval or arguments operand in strict mode',
        StrictLHSPrefix:  'Prefix increment/decrement may not have eval or arguments operand in strict mode',
        StrictReservedWord:  'Use of future reserved word in strict mode'
    };

    // See also tools/generate-unicode-regex.py.
    Regex = {
        NonAsciiIdentifierStart: new RegExp('[\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u08a0\u08a2-\u08ac\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097f\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d\u0c58\u0c59\u0c60\u0c61\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d60\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1877\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191c\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19c1-\u19c7\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4b\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1ce9-\u1cec\u1cee-\u1cf1\u1cf5\u1cf6\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua697\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa80-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc]'),
        NonAsciiIdentifierPart: new RegExp('[\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0300-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u0483-\u0487\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u05d0-\u05ea\u05f0-\u05f2\u0610-\u061a\u0620-\u0669\u066e-\u06d3\u06d5-\u06dc\u06df-\u06e8\u06ea-\u06fc\u06ff\u0710-\u074a\u074d-\u07b1\u07c0-\u07f5\u07fa\u0800-\u082d\u0840-\u085b\u08a0\u08a2-\u08ac\u08e4-\u08fe\u0900-\u0963\u0966-\u096f\u0971-\u0977\u0979-\u097f\u0981-\u0983\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bc-\u09c4\u09c7\u09c8\u09cb-\u09ce\u09d7\u09dc\u09dd\u09df-\u09e3\u09e6-\u09f1\u0a01-\u0a03\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a59-\u0a5c\u0a5e\u0a66-\u0a75\u0a81-\u0a83\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abc-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ad0\u0ae0-\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3c-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b5c\u0b5d\u0b5f-\u0b63\u0b66-\u0b6f\u0b71\u0b82\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd0\u0bd7\u0be6-\u0bef\u0c01-\u0c03\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c58\u0c59\u0c60-\u0c63\u0c66-\u0c6f\u0c82\u0c83\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbc-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0cde\u0ce0-\u0ce3\u0ce6-\u0cef\u0cf1\u0cf2\u0d02\u0d03\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d-\u0d44\u0d46-\u0d48\u0d4a-\u0d4e\u0d57\u0d60-\u0d63\u0d66-\u0d6f\u0d7a-\u0d7f\u0d82\u0d83\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2\u0df3\u0e01-\u0e3a\u0e40-\u0e4e\u0e50-\u0e59\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb9\u0ebb-\u0ebd\u0ec0-\u0ec4\u0ec6\u0ec8-\u0ecd\u0ed0-\u0ed9\u0edc-\u0edf\u0f00\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f3e-\u0f47\u0f49-\u0f6c\u0f71-\u0f84\u0f86-\u0f97\u0f99-\u0fbc\u0fc6\u1000-\u1049\u1050-\u109d\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u135d-\u135f\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176c\u176e-\u1770\u1772\u1773\u1780-\u17d3\u17d7\u17dc\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u1820-\u1877\u1880-\u18aa\u18b0-\u18f5\u1900-\u191c\u1920-\u192b\u1930-\u193b\u1946-\u196d\u1970-\u1974\u1980-\u19ab\u19b0-\u19c9\u19d0-\u19d9\u1a00-\u1a1b\u1a20-\u1a5e\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1aa7\u1b00-\u1b4b\u1b50-\u1b59\u1b6b-\u1b73\u1b80-\u1bf3\u1c00-\u1c37\u1c40-\u1c49\u1c4d-\u1c7d\u1cd0-\u1cd2\u1cd4-\u1cf6\u1d00-\u1de6\u1dfc-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u200c\u200d\u203f\u2040\u2054\u2071\u207f\u2090-\u209c\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d7f-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2de0-\u2dff\u2e2f\u3005-\u3007\u3021-\u302f\u3031-\u3035\u3038-\u303c\u3041-\u3096\u3099\u309a\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua62b\ua640-\ua66f\ua674-\ua67d\ua67f-\ua697\ua69f-\ua6f1\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua827\ua840-\ua873\ua880-\ua8c4\ua8d0-\ua8d9\ua8e0-\ua8f7\ua8fb\ua900-\ua92d\ua930-\ua953\ua960-\ua97c\ua980-\ua9c0\ua9cf-\ua9d9\uaa00-\uaa36\uaa40-\uaa4d\uaa50-\uaa59\uaa60-\uaa76\uaa7a\uaa7b\uaa80-\uaac2\uaadb-\uaadd\uaae0-\uaaef\uaaf2-\uaaf6\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabea\uabec\uabed\uabf0-\uabf9\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe00-\ufe0f\ufe20-\ufe26\ufe33\ufe34\ufe4d-\ufe4f\ufe70-\ufe74\ufe76-\ufefc\uff10-\uff19\uff21-\uff3a\uff3f\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc]')
    };

    // Ensure the condition is true, otherwise throw an error.
    // This is only to have a better contract semantic, i.e. another safety net
    // to catch a logic error. The condition shall be fulfilled in normal case.
    // Do NOT use this to enforce a certain condition on any user input.

    function assert(condition, message) {
        if (!condition) {
            throw new Error('ASSERT: ' + message);
        }
    }

    function sliceSource(from, to) {
        return source.slice(from, to);
    }

    if (typeof 'esprima'[0] === 'undefined') {
        sliceSource = function sliceArraySource(from, to) {
            return source.slice(from, to).join('');
        };
    }

    function isDecimalDigit(ch) {
        return '0123456789'.indexOf(ch) >= 0;
    }

    function isHexDigit(ch) {
        return '0123456789abcdefABCDEF'.indexOf(ch) >= 0;
    }

    function isOctalDigit(ch) {
        return '01234567'.indexOf(ch) >= 0;
    }


    // 7.2 White Space

    function isWhiteSpace(ch) {
        return (ch === ' ') || (ch === '\u0009') || (ch === '\u000B') ||
            (ch === '\u000C') || (ch === '\u00A0') ||
            (ch.charCodeAt(0) >= 0x1680 &&
             '\u1680\u180E\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\uFEFF'.indexOf(ch) >= 0);
    }

    // 7.3 Line Terminators

    function isLineTerminator(ch) {
        return (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029');
    }

    // 7.6 Identifier Names and Identifiers

    function isIdentifierStart(ch) {
        return (ch === '$') || (ch === '_') || (ch === '\\') ||
            (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
            ((ch.charCodeAt(0) >= 0x80) && Regex.NonAsciiIdentifierStart.test(ch));
    }

    function isIdentifierPart(ch) {
        return (ch === '$') || (ch === '_') || (ch === '\\') ||
            (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
            ((ch >= '0') && (ch <= '9')) ||
            ((ch.charCodeAt(0) >= 0x80) && Regex.NonAsciiIdentifierPart.test(ch));
    }

    // 7.6.1.2 Future Reserved Words

    function isFutureReservedWord(id) {
        switch (id) {

        // Future reserved words.
        case 'class':
        case 'enum':
        case 'export':
        case 'extends':
        case 'import':
        case 'super':
            return true;
        }

        return false;
    }

    function isStrictModeReservedWord(id) {
        switch (id) {

        // Strict Mode reserved words.
        case 'implements':
        case 'interface':
        case 'package':
        case 'private':
        case 'protected':
        case 'public':
        case 'static':
        case 'yield':
        case 'let':
            return true;
        }

        return false;
    }

    function isRestrictedWord(id) {
        return id === 'eval' || id === 'arguments';
    }

    // 7.6.1.1 Keywords

    function isKeyword(id) {
        var keyword = false;
        switch (id.length) {
        case 2:
            keyword = (id === 'if') || (id === 'in') || (id === 'do');
            break;
        case 3:
            keyword = (id === 'var') || (id === 'for') || (id === 'new') || (id === 'try');
            break;
        case 4:
            keyword = (id === 'this') || (id === 'else') || (id === 'case') || (id === 'void') || (id === 'with');
            break;
        case 5:
            keyword = (id === 'while') || (id === 'break') || (id === 'catch') || (id === 'throw');
            break;
        case 6:
            keyword = (id === 'return') || (id === 'typeof') || (id === 'delete') || (id === 'switch');
            break;
        case 7:
            keyword = (id === 'default') || (id === 'finally');
            break;
        case 8:
            keyword = (id === 'function') || (id === 'continue') || (id === 'debugger');
            break;
        case 10:
            keyword = (id === 'instanceof');
            break;
        }

        if (keyword) {
            return true;
        }

        switch (id) {
        // Future reserved words.
        // 'const' is specialized as Keyword in V8.
        case 'const':
            return true;

        // For compatiblity to SpiderMonkey and ES.next
        case 'yield':
        case 'let':
            return true;
        }

        if (strict && isStrictModeReservedWord(id)) {
            return true;
        }

        return isFutureReservedWord(id);
    }

    // 7.4 Comments

    function skipComment() {
        var ch, blockComment, lineComment;

        blockComment = false;
        lineComment = false;

        while (index < length) {
            ch = source[index];

            if (lineComment) {
                ch = source[index++];
                if (isLineTerminator(ch)) {
                    lineComment = false;
                    if (ch === '\r' && source[index] === '\n') {
                        ++index;
                    }
                    ++lineNumber;
                    lineStart = index;
                }
            } else if (blockComment) {
                if (isLineTerminator(ch)) {
                    if (ch === '\r' && source[index + 1] === '\n') {
                        ++index;
                    }
                    ++lineNumber;
                    ++index;
                    lineStart = index;
                    if (index >= length) {
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }
                } else {
                    ch = source[index++];
                    if (index >= length) {
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }
                    if (ch === '*') {
                        ch = source[index];
                        if (ch === '/') {
                            ++index;
                            blockComment = false;
                        }
                    }
                }
            } else if (ch === '/') {
                ch = source[index + 1];
                if (ch === '/') {
                    index += 2;
                    lineComment = true;
                } else if (ch === '*') {
                    index += 2;
                    blockComment = true;
                    if (index >= length) {
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }
                } else {
                    break;
                }
            } else if (isWhiteSpace(ch)) {
                ++index;
            } else if (isLineTerminator(ch)) {
                ++index;
                if (ch ===  '\r' && source[index] === '\n') {
                    ++index;
                }
                ++lineNumber;
                lineStart = index;
            } else {
                break;
            }
        }
    }

    function scanHexEscape(prefix) {
        var i, len, ch, code = 0;

        len = (prefix === 'u') ? 4 : 2;
        for (i = 0; i < len; ++i) {
            if (index < length && isHexDigit(source[index])) {
                ch = source[index++];
                code = code * 16 + '0123456789abcdef'.indexOf(ch.toLowerCase());
            } else {
                return '';
            }
        }
        return String.fromCharCode(code);
    }

    function scanIdentifier() {
        var ch, start, id, restore;

        ch = source[index];
        if (!isIdentifierStart(ch)) {
            return;
        }

        start = index;
        if (ch === '\\') {
            ++index;
            if (source[index] !== 'u') {
                return;
            }
            ++index;
            restore = index;
            ch = scanHexEscape('u');
            if (ch) {
                if (ch === '\\' || !isIdentifierStart(ch)) {
                    return;
                }
                id = ch;
            } else {
                index = restore;
                id = 'u';
            }
        } else {
            id = source[index++];
        }

        while (index < length) {
            ch = source[index];
            if (!isIdentifierPart(ch)) {
                break;
            }
            if (ch === '\\') {
                ++index;
                if (source[index] !== 'u') {
                    return;
                }
                ++index;
                restore = index;
                ch = scanHexEscape('u');
                if (ch) {
                    if (ch === '\\' || !isIdentifierPart(ch)) {
                        return;
                    }
                    id += ch;
                } else {
                    index = restore;
                    id += 'u';
                }
            } else {
                id += source[index++];
            }
        }

        // There is no keyword or literal with only one character.
        // Thus, it must be an identifier.
        if (id.length === 1) {
            return {
                type: Token.Identifier,
                value: id,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        if (isKeyword(id)) {
            return {
                type: Token.Keyword,
                value: id,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        // 7.8.1 Null Literals

        if (id === 'null') {
            return {
                type: Token.NullLiteral,
                value: id,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        // 7.8.2 Boolean Literals

        if (id === 'true' || id === 'false') {
            return {
                type: Token.BooleanLiteral,
                value: id,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        return {
            type: Token.Identifier,
            value: id,
            lineNumber: lineNumber,
            lineStart: lineStart,
            range: [start, index]
        };
    }

    // 7.7 Punctuators

    function scanPunctuator() {
        var start = index,
            ch1 = source[index],
            ch2,
            ch3,
            ch4;

        // Check for most common single-character punctuators.

        if (ch1 === ';' || ch1 === '{' || ch1 === '}') {
            ++index;
            return {
                type: Token.Punctuator,
                value: ch1,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        if (ch1 === ',' || ch1 === '(' || ch1 === ')') {
            ++index;
            return {
                type: Token.Punctuator,
                value: ch1,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        // Dot (.) can also start a floating-point number, hence the need
        // to check the next character.

        ch2 = source[index + 1];
        if (ch1 === '.' && !isDecimalDigit(ch2)) {
            return {
                type: Token.Punctuator,
                value: source[index++],
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        // Peek more characters.

        ch3 = source[index + 2];
        ch4 = source[index + 3];

        // 4-character punctuator: >>>=

        if (ch1 === '>' && ch2 === '>' && ch3 === '>') {
            if (ch4 === '=') {
                index += 4;
                return {
                    type: Token.Punctuator,
                    value: '>>>=',
                    lineNumber: lineNumber,
                    lineStart: lineStart,
                    range: [start, index]
                };
            }
        }

        // 3-character punctuators: === !== >>> <<= >>=

        if (ch1 === '=' && ch2 === '=' && ch3 === '=') {
            index += 3;
            return {
                type: Token.Punctuator,
                value: '===',
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        if (ch1 === '!' && ch2 === '=' && ch3 === '=') {
            index += 3;
            return {
                type: Token.Punctuator,
                value: '!==',
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        if (ch1 === '>' && ch2 === '>' && ch3 === '>') {
            index += 3;
            return {
                type: Token.Punctuator,
                value: '>>>',
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        if (ch1 === '<' && ch2 === '<' && ch3 === '=') {
            index += 3;
            return {
                type: Token.Punctuator,
                value: '<<=',
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        if (ch1 === '>' && ch2 === '>' && ch3 === '=') {
            index += 3;
            return {
                type: Token.Punctuator,
                value: '>>=',
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }

        // 2-character punctuators: <= >= == != ++ -- << >> && ||
        // += -= *= %= &= |= ^= /=

        if (ch2 === '=') {
            if ('<>=!+-*%&|^/'.indexOf(ch1) >= 0) {
                index += 2;
                return {
                    type: Token.Punctuator,
                    value: ch1 + ch2,
                    lineNumber: lineNumber,
                    lineStart: lineStart,
                    range: [start, index]
                };
            }
        }

        if (ch1 === ch2 && ('+-<>&|'.indexOf(ch1) >= 0)) {
            if ('+-<>&|'.indexOf(ch2) >= 0) {
                index += 2;
                return {
                    type: Token.Punctuator,
                    value: ch1 + ch2,
                    lineNumber: lineNumber,
                    lineStart: lineStart,
                    range: [start, index]
                };
            }
        }

        // The remaining 1-character punctuators.

        if ('[]<>+-*%&|^!~?:=/'.indexOf(ch1) >= 0) {
            return {
                type: Token.Punctuator,
                value: source[index++],
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [start, index]
            };
        }
    }

    // 7.8.3 Numeric Literals

    function scanNumericLiteral() {
        var number, start, ch;

        ch = source[index];
        assert(isDecimalDigit(ch) || (ch === '.'),
            'Numeric literal must start with a decimal digit or a decimal point');

        start = index;
        number = '';
        if (ch !== '.') {
            number = source[index++];
            ch = source[index];

            // Hex number starts with '0x'.
            // Octal number starts with '0'.
            if (number === '0') {
                if (ch === 'x' || ch === 'X') {
                    number += source[index++];
                    while (index < length) {
                        ch = source[index];
                        if (!isHexDigit(ch)) {
                            break;
                        }
                        number += source[index++];
                    }

                    if (number.length <= 2) {
                        // only 0x
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }

                    if (index < length) {
                        ch = source[index];
                        if (isIdentifierStart(ch)) {
                            throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                        }
                    }
                    return {
                        type: Token.NumericLiteral,
                        value: parseInt(number, 16),
                        lineNumber: lineNumber,
                        lineStart: lineStart,
                        range: [start, index]
                    };
                } else if (isOctalDigit(ch)) {
                    number += source[index++];
                    while (index < length) {
                        ch = source[index];
                        if (!isOctalDigit(ch)) {
                            break;
                        }
                        number += source[index++];
                    }

                    if (index < length) {
                        ch = source[index];
                        if (isIdentifierStart(ch) || isDecimalDigit(ch)) {
                            throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                        }
                    }
                    return {
                        type: Token.NumericLiteral,
                        value: parseInt(number, 8),
                        octal: true,
                        lineNumber: lineNumber,
                        lineStart: lineStart,
                        range: [start, index]
                    };
                }

                // decimal number starts with '0' such as '09' is illegal.
                if (isDecimalDigit(ch)) {
                    throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                }
            }

            while (index < length) {
                ch = source[index];
                if (!isDecimalDigit(ch)) {
                    break;
                }
                number += source[index++];
            }
        }

        if (ch === '.') {
            number += source[index++];
            while (index < length) {
                ch = source[index];
                if (!isDecimalDigit(ch)) {
                    break;
                }
                number += source[index++];
            }
        }

        if (ch === 'e' || ch === 'E') {
            number += source[index++];

            ch = source[index];
            if (ch === '+' || ch === '-') {
                number += source[index++];
            }

            ch = source[index];
            if (isDecimalDigit(ch)) {
                number += source[index++];
                while (index < length) {
                    ch = source[index];
                    if (!isDecimalDigit(ch)) {
                        break;
                    }
                    number += source[index++];
                }
            } else {
                ch = 'character ' + ch;
                if (index >= length) {
                    ch = '<end>';
                }
                throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
            }
        }

        if (index < length) {
            ch = source[index];
            if (isIdentifierStart(ch)) {
                throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
            }
        }

        return {
            type: Token.NumericLiteral,
            value: parseFloat(number),
            lineNumber: lineNumber,
            lineStart: lineStart,
            range: [start, index]
        };
    }

    // 7.8.4 String Literals

    function scanStringLiteral() {
        var str = '', quote, start, ch, code, unescaped, restore, octal = false;

        quote = source[index];
        assert((quote === '\'' || quote === '"'),
            'String literal must starts with a quote');

        start = index;
        ++index;

        while (index < length) {
            ch = source[index++];

            if (ch === quote) {
                quote = '';
                break;
            } else if (ch === '\\') {
                ch = source[index++];
                if (!isLineTerminator(ch)) {
                    switch (ch) {
                    case 'n':
                        str += '\n';
                        break;
                    case 'r':
                        str += '\r';
                        break;
                    case 't':
                        str += '\t';
                        break;
                    case 'u':
                    case 'x':
                        restore = index;
                        unescaped = scanHexEscape(ch);
                        if (unescaped) {
                            str += unescaped;
                        } else {
                            index = restore;
                            str += ch;
                        }
                        break;
                    case 'b':
                        str += '\b';
                        break;
                    case 'f':
                        str += '\f';
                        break;
                    case 'v':
                        str += '\v';
                        break;

                    default:
                        if (isOctalDigit(ch)) {
                            code = '01234567'.indexOf(ch);

                            // \0 is not octal escape sequence
                            if (code !== 0) {
                                octal = true;
                            }

                            if (index < length && isOctalDigit(source[index])) {
                                octal = true;
                                code = code * 8 + '01234567'.indexOf(source[index++]);

                                // 3 digits are only allowed when string starts
                                // with 0, 1, 2, 3
                                if ('0123'.indexOf(ch) >= 0 &&
                                        index < length &&
                                        isOctalDigit(source[index])) {
                                    code = code * 8 + '01234567'.indexOf(source[index++]);
                                }
                            }
                            str += String.fromCharCode(code);
                        } else {
                            str += ch;
                        }
                        break;
                    }
                } else {
                    ++lineNumber;
                    if (ch ===  '\r' && source[index] === '\n') {
                        ++index;
                    }
                }
            } else if (isLineTerminator(ch)) {
                break;
            } else {
                str += ch;
            }
        }

        if (quote !== '') {
            throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
        }

        return {
            type: Token.StringLiteral,
            value: str,
            octal: octal,
            lineNumber: lineNumber,
            lineStart: lineStart,
            range: [start, index]
        };
    }

    function scanRegExp() {
        var str, ch, start, pattern, flags, value, classMarker = false, restore, terminated = false;

        buffer = null;
        skipComment();

        start = index;
        ch = source[index];
        assert(ch === '/', 'Regular expression literal must start with a slash');
        str = source[index++];

        while (index < length) {
            ch = source[index++];
            str += ch;
            if (classMarker) {
                if (ch === ']') {
                    classMarker = false;
                }
            } else {
                if (ch === '\\') {
                    ch = source[index++];
                    // ECMA-262 7.8.5
                    if (isLineTerminator(ch)) {
                        throwError({}, Messages.UnterminatedRegExp);
                    }
                    str += ch;
                } else if (ch === '/') {
                    terminated = true;
                    break;
                } else if (ch === '[') {
                    classMarker = true;
                } else if (isLineTerminator(ch)) {
                    throwError({}, Messages.UnterminatedRegExp);
                }
            }
        }

        if (!terminated) {
            throwError({}, Messages.UnterminatedRegExp);
        }

        // Exclude leading and trailing slash.
        pattern = str.substr(1, str.length - 2);

        flags = '';
        while (index < length) {
            ch = source[index];
            if (!isIdentifierPart(ch)) {
                break;
            }

            ++index;
            if (ch === '\\' && index < length) {
                ch = source[index];
                if (ch === 'u') {
                    ++index;
                    restore = index;
                    ch = scanHexEscape('u');
                    if (ch) {
                        flags += ch;
                        str += '\\u';
                        for (; restore < index; ++restore) {
                            str += source[restore];
                        }
                    } else {
                        index = restore;
                        flags += 'u';
                        str += '\\u';
                    }
                } else {
                    str += '\\';
                }
            } else {
                flags += ch;
                str += ch;
            }
        }

        try {
            value = new RegExp(pattern, flags);
        } catch (e) {
            throwError({}, Messages.InvalidRegExp);
        }

        return {
            literal: str,
            value: value,
            range: [start, index]
        };
    }

    function isIdentifierName(token) {
        return token.type === Token.Identifier ||
            token.type === Token.Keyword ||
            token.type === Token.BooleanLiteral ||
            token.type === Token.NullLiteral;
    }

    function advance() {
        var ch, token;

        skipComment();

        if (index >= length) {
            return {
                type: Token.EOF,
                lineNumber: lineNumber,
                lineStart: lineStart,
                range: [index, index]
            };
        }

        token = scanPunctuator();
        if (typeof token !== 'undefined') {
            return token;
        }

        ch = source[index];

        if (ch === '\'' || ch === '"') {
            return scanStringLiteral();
        }

        if (ch === '.' || isDecimalDigit(ch)) {
            return scanNumericLiteral();
        }

        token = scanIdentifier();
        if (typeof token !== 'undefined') {
            return token;
        }

        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
    }

    function lex() {
        var token;

        if (buffer) {
            index = buffer.range[1];
            lineNumber = buffer.lineNumber;
            lineStart = buffer.lineStart;
            token = buffer;
            buffer = null;
            return token;
        }

        buffer = null;
        return advance();
    }

    function lookahead() {
        var pos, line, start;

        if (buffer !== null) {
            return buffer;
        }

        pos = index;
        line = lineNumber;
        start = lineStart;
        buffer = advance();
        index = pos;
        lineNumber = line;
        lineStart = start;

        return buffer;
    }

    // Return true if there is a line terminator before the next token.

    function peekLineTerminator() {
        var pos, line, start, found;

        pos = index;
        line = lineNumber;
        start = lineStart;
        skipComment();
        found = lineNumber !== line;
        index = pos;
        lineNumber = line;
        lineStart = start;

        return found;
    }

    // Throw an exception

    function throwError(token, messageFormat) {
        var error,
            args = Array.prototype.slice.call(arguments, 2),
            msg = messageFormat.replace(
                /%(\d)/g,
                function (whole, index) {
                    return args[index] || '';
                }
            );

        if (typeof token.lineNumber === 'number') {
            error = new Error('Line ' + token.lineNumber + ': ' + msg);
            error.index = token.range[0];
            error.lineNumber = token.lineNumber;
            error.column = token.range[0] - lineStart + 1;
        } else {
            error = new Error('Line ' + lineNumber + ': ' + msg);
            error.index = index;
            error.lineNumber = lineNumber;
            error.column = index - lineStart + 1;
        }

        throw error;
    }

    function throwErrorTolerant() {
        try {
            throwError.apply(null, arguments);
        } catch (e) {
            if (extra.errors) {
                extra.errors.push(e);
            } else {
                throw e;
            }
        }
    }


    // Throw an exception because of the token.

    function throwUnexpected(token) {
        if (token.type === Token.EOF) {
            throwError(token, Messages.UnexpectedEOS);
        }

        if (token.type === Token.NumericLiteral) {
            throwError(token, Messages.UnexpectedNumber);
        }

        if (token.type === Token.StringLiteral) {
            throwError(token, Messages.UnexpectedString);
        }

        if (token.type === Token.Identifier) {
            throwError(token, Messages.UnexpectedIdentifier);
        }

        if (token.type === Token.Keyword) {
            if (isFutureReservedWord(token.value)) {
                throwError(token, Messages.UnexpectedReserved);
            } else if (strict && isStrictModeReservedWord(token.value)) {
                throwErrorTolerant(token, Messages.StrictReservedWord);
                return;
            }
            throwError(token, Messages.UnexpectedToken, token.value);
        }

        // BooleanLiteral, NullLiteral, or Punctuator.
        throwError(token, Messages.UnexpectedToken, token.value);
    }

    // Expect the next token to match the specified punctuator.
    // If not, an exception will be thrown.

    function expect(value) {
        var token = lex();
        if (token.type !== Token.Punctuator || token.value !== value) {
            throwUnexpected(token);
        }
    }

    // Expect the next token to match the specified keyword.
    // If not, an exception will be thrown.

    function expectKeyword(keyword) {
        var token = lex();
        if (token.type !== Token.Keyword || token.value !== keyword) {
            throwUnexpected(token);
        }
    }

    // Return true if the next token matches the specified punctuator.

    function match(value) {
        var token = lookahead();
        return token.type === Token.Punctuator && token.value === value;
    }

    // Return true if the next token matches the specified keyword

    function matchKeyword(keyword) {
        var token = lookahead();
        return token.type === Token.Keyword && token.value === keyword;
    }

    // Return true if the next token is an assignment operator

    function matchAssign() {
        var token = lookahead(),
            op = token.value;

        if (token.type !== Token.Punctuator) {
            return false;
        }
        return op === '=' ||
            op === '*=' ||
            op === '/=' ||
            op === '%=' ||
            op === '+=' ||
            op === '-=' ||
            op === '<<=' ||
            op === '>>=' ||
            op === '>>>=' ||
            op === '&=' ||
            op === '^=' ||
            op === '|=';
    }

    function consumeSemicolon() {
        var token, line;

        // Catch the very common case first.
        if (source[index] === ';') {
            lex();
            return;
        }

        line = lineNumber;
        skipComment();
        if (lineNumber !== line) {
            return;
        }

        if (match(';')) {
            lex();
            return;
        }

        token = lookahead();
        if (token.type !== Token.EOF && !match('}')) {
            throwUnexpected(token);
        }
    }

    // Return true if provided expression is LeftHandSideExpression

    function isLeftHandSide(expr) {
        return expr.type === Syntax.Identifier || expr.type === Syntax.MemberExpression;
    }

    // 11.1.4 Array Initialiser

    function parseArrayInitialiser() {
        var elements = [];

        expect('[');

        while (!match(']')) {
            if (match(',')) {
                lex();
                elements.push(null);
            } else {
                elements.push(parseAssignmentExpression());

                if (!match(']')) {
                    expect(',');
                }
            }
        }

        expect(']');

        return {
            type: Syntax.ArrayExpression,
            elements: elements
        };
    }

    // 11.1.5 Object Initialiser

    function parsePropertyFunction(param, first) {
        var previousStrict, body;

        previousStrict = strict;
        body = parseFunctionSourceElements();
        if (first && strict && isRestrictedWord(param[0].name)) {
            throwErrorTolerant(first, Messages.StrictParamName);
        }
        strict = previousStrict;

        return {
            type: Syntax.FunctionExpression,
            id: null,
            params: param,
            defaults: [],
            body: body,
            rest: null,
            generator: false,
            expression: false
        };
    }

    function parseObjectPropertyKey() {
        var token = lex();

        // Note: This function is called only from parseObjectProperty(), where
        // EOF and Punctuator tokens are already filtered out.

        if (token.type === Token.StringLiteral || token.type === Token.NumericLiteral) {
            if (strict && token.octal) {
                throwErrorTolerant(token, Messages.StrictOctalLiteral);
            }
            return createLiteral(token);
        }

        return {
            type: Syntax.Identifier,
            name: token.value
        };
    }

    function parseObjectProperty() {
        var token, key, id, param;

        token = lookahead();

        if (token.type === Token.Identifier) {

            id = parseObjectPropertyKey();

            // Property Assignment: Getter and Setter.

            if (token.value === 'get' && !match(':')) {
                key = parseObjectPropertyKey();
                expect('(');
                expect(')');
                return {
                    type: Syntax.Property,
                    key: key,
                    value: parsePropertyFunction([]),
                    kind: 'get'
                };
            } else if (token.value === 'set' && !match(':')) {
                key = parseObjectPropertyKey();
                expect('(');
                token = lookahead();
                if (token.type !== Token.Identifier) {
                    throwUnexpected(lex());
                }
                param = [ parseVariableIdentifier() ];
                expect(')');
                return {
                    type: Syntax.Property,
                    key: key,
                    value: parsePropertyFunction(param, token),
                    kind: 'set'
                };
            } else {
                expect(':');
                return {
                    type: Syntax.Property,
                    key: id,
                    value: parseAssignmentExpression(),
                    kind: 'init'
                };
            }
        } else if (token.type === Token.EOF || token.type === Token.Punctuator) {
            throwUnexpected(token);
        } else {
            key = parseObjectPropertyKey();
            expect(':');
            return {
                type: Syntax.Property,
                key: key,
                value: parseAssignmentExpression(),
                kind: 'init'
            };
        }
    }

    function parseObjectInitialiser() {
        var properties = [], property, name, kind, map = {}, toString = String;

        expect('{');

        while (!match('}')) {
            property = parseObjectProperty();

            if (property.key.type === Syntax.Identifier) {
                name = property.key.name;
            } else {
                name = toString(property.key.value);
            }
            kind = (property.kind === 'init') ? PropertyKind.Data : (property.kind === 'get') ? PropertyKind.Get : PropertyKind.Set;
            if (Object.prototype.hasOwnProperty.call(map, name)) {
                if (map[name] === PropertyKind.Data) {
                    if (strict && kind === PropertyKind.Data) {
                        throwErrorTolerant({}, Messages.StrictDuplicateProperty);
                    } else if (kind !== PropertyKind.Data) {
                        throwErrorTolerant({}, Messages.AccessorDataProperty);
                    }
                } else {
                    if (kind === PropertyKind.Data) {
                        throwErrorTolerant({}, Messages.AccessorDataProperty);
                    } else if (map[name] & kind) {
                        throwErrorTolerant({}, Messages.AccessorGetSet);
                    }
                }
                map[name] |= kind;
            } else {
                map[name] = kind;
            }

            properties.push(property);

            if (!match('}')) {
                expect(',');
            }
        }

        expect('}');

        return {
            type: Syntax.ObjectExpression,
            properties: properties
        };
    }

    // 11.1.6 The Grouping Operator

    function parseGroupExpression() {
        var expr;

        expect('(');

        expr = parseExpression();

        expect(')');

        return expr;
    }


    // 11.1 Primary Expressions

    function parsePrimaryExpression() {
        var token = lookahead(),
            type = token.type;

        if (type === Token.Identifier) {
            return {
                type: Syntax.Identifier,
                name: lex().value
            };
        }

        if (type === Token.StringLiteral || type === Token.NumericLiteral) {
            if (strict && token.octal) {
                throwErrorTolerant(token, Messages.StrictOctalLiteral);
            }
            return createLiteral(lex());
        }

        if (type === Token.Keyword) {
            if (matchKeyword('this')) {
                lex();
                return {
                    type: Syntax.ThisExpression
                };
            }

            if (matchKeyword('function')) {
                return parseFunctionExpression();
            }
        }

        if (type === Token.BooleanLiteral) {
            lex();
            token.value = (token.value === 'true');
            return createLiteral(token);
        }

        if (type === Token.NullLiteral) {
            lex();
            token.value = null;
            return createLiteral(token);
        }

        if (match('[')) {
            return parseArrayInitialiser();
        }

        if (match('{')) {
            return parseObjectInitialiser();
        }

        if (match('(')) {
            return parseGroupExpression();
        }

        if (match('/') || match('/=')) {
            return createLiteral(scanRegExp());
        }

        return throwUnexpected(lex());
    }

    // 11.2 Left-Hand-Side Expressions

    function parseArguments() {
        var args = [];

        expect('(');

        if (!match(')')) {
            while (index < length) {
                args.push(parseAssignmentExpression());
                if (match(')')) {
                    break;
                }
                expect(',');
            }
        }

        expect(')');

        return args;
    }

    function parseNonComputedProperty() {
        var token = lex();

        if (!isIdentifierName(token)) {
            throwUnexpected(token);
        }

        return {
            type: Syntax.Identifier,
            name: token.value
        };
    }

    function parseNonComputedMember() {
        expect('.');

        return parseNonComputedProperty();
    }

    function parseComputedMember() {
        var expr;

        expect('[');

        expr = parseExpression();

        expect(']');

        return expr;
    }

    function parseNewExpression() {
        var expr;

        expectKeyword('new');

        expr = {
            type: Syntax.NewExpression,
            callee: parseLeftHandSideExpression(),
            'arguments': []
        };

        if (match('(')) {
            expr['arguments'] = parseArguments();
        }

        return expr;
    }

    function parseLeftHandSideExpressionAllowCall() {
        var expr;

        expr = matchKeyword('new') ? parseNewExpression() : parsePrimaryExpression();

        while (match('.') || match('[') || match('(')) {
            if (match('(')) {
                expr = {
                    type: Syntax.CallExpression,
                    callee: expr,
                    'arguments': parseArguments()
                };
            } else if (match('[')) {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: true,
                    object: expr,
                    property: parseComputedMember()
                };
            } else {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: false,
                    object: expr,
                    property: parseNonComputedMember()
                };
            }
        }

        return expr;
    }


    function parseLeftHandSideExpression() {
        var expr;

        expr = matchKeyword('new') ? parseNewExpression() : parsePrimaryExpression();

        while (match('.') || match('[')) {
            if (match('[')) {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: true,
                    object: expr,
                    property: parseComputedMember()
                };
            } else {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: false,
                    object: expr,
                    property: parseNonComputedMember()
                };
            }
        }

        return expr;
    }

    // 11.3 Postfix Expressions

    function parsePostfixExpression() {
        var expr = parseLeftHandSideExpressionAllowCall(), token;

        token = lookahead();
        if (token.type !== Token.Punctuator) {
            return expr;
        }

        if ((match('++') || match('--')) && !peekLineTerminator()) {
            // 11.3.1, 11.3.2
            if (strict && expr.type === Syntax.Identifier && isRestrictedWord(expr.name)) {
                throwErrorTolerant({}, Messages.StrictLHSPostfix);
            }

            if (!isLeftHandSide(expr)) {
                throwError({}, Messages.InvalidLHSInAssignment);
            }

            expr = {
                type: Syntax.UpdateExpression,
                operator: lex().value,
                argument: expr,
                prefix: false
            };
        }

        return expr;
    }

    // 11.4 Unary Operators

    function parseUnaryExpression() {
        var token, expr;

        token = lookahead();
        if (token.type !== Token.Punctuator && token.type !== Token.Keyword) {
            return parsePostfixExpression();
        }

        if (match('++') || match('--')) {
            token = lex();
            expr = parseUnaryExpression();
            // 11.4.4, 11.4.5
            if (strict && expr.type === Syntax.Identifier && isRestrictedWord(expr.name)) {
                throwErrorTolerant({}, Messages.StrictLHSPrefix);
            }

            if (!isLeftHandSide(expr)) {
                throwError({}, Messages.InvalidLHSInAssignment);
            }

            expr = {
                type: Syntax.UpdateExpression,
                operator: token.value,
                argument: expr,
                prefix: true
            };
            return expr;
        }

        if (match('+') || match('-') || match('~') || match('!')) {
            expr = {
                type: Syntax.UnaryExpression,
                operator: lex().value,
                argument: parseUnaryExpression()
            };
            return expr;
        }

        if (matchKeyword('delete') || matchKeyword('void') || matchKeyword('typeof')) {
            expr = {
                type: Syntax.UnaryExpression,
                operator: lex().value,
                argument: parseUnaryExpression()
            };
            if (strict && expr.operator === 'delete' && expr.argument.type === Syntax.Identifier) {
                throwErrorTolerant({}, Messages.StrictDelete);
            }
            return expr;
        }

        return parsePostfixExpression();
    }

    // 11.5 Multiplicative Operators

    function parseMultiplicativeExpression() {
        var expr = parseUnaryExpression();

        while (match('*') || match('/') || match('%')) {
            expr = {
                type: Syntax.BinaryExpression,
                operator: lex().value,
                left: expr,
                right: parseUnaryExpression()
            };
        }

        return expr;
    }

    // 11.6 Additive Operators

    function parseAdditiveExpression() {
        var expr = parseMultiplicativeExpression();

        while (match('+') || match('-')) {
            expr = {
                type: Syntax.BinaryExpression,
                operator: lex().value,
                left: expr,
                right: parseMultiplicativeExpression()
            };
        }

        return expr;
    }

    // 11.7 Bitwise Shift Operators

    function parseShiftExpression() {
        var expr = parseAdditiveExpression();

        while (match('<<') || match('>>') || match('>>>')) {
            expr = {
                type: Syntax.BinaryExpression,
                operator: lex().value,
                left: expr,
                right: parseAdditiveExpression()
            };
        }

        return expr;
    }
    // 11.8 Relational Operators

    function parseRelationalExpression() {
        var expr, previousAllowIn;

        previousAllowIn = state.allowIn;
        state.allowIn = true;

        expr = parseShiftExpression();

        while (match('<') || match('>') || match('<=') || match('>=') || (previousAllowIn && matchKeyword('in')) || matchKeyword('instanceof')) {
            expr = {
                type: Syntax.BinaryExpression,
                operator: lex().value,
                left: expr,
                right: parseShiftExpression()
            };
        }

        state.allowIn = previousAllowIn;
        return expr;
    }

    // 11.9 Equality Operators

    function parseEqualityExpression() {
        var expr = parseRelationalExpression();

        while (match('==') || match('!=') || match('===') || match('!==')) {
            expr = {
                type: Syntax.BinaryExpression,
                operator: lex().value,
                left: expr,
                right: parseRelationalExpression()
            };
        }

        return expr;
    }

    // 11.10 Binary Bitwise Operators

    function parseBitwiseANDExpression() {
        var expr = parseEqualityExpression();

        while (match('&')) {
            lex();
            expr = {
                type: Syntax.BinaryExpression,
                operator: '&',
                left: expr,
                right: parseEqualityExpression()
            };
        }

        return expr;
    }

    function parseBitwiseXORExpression() {
        var expr = parseBitwiseANDExpression();

        while (match('^')) {
            lex();
            expr = {
                type: Syntax.BinaryExpression,
                operator: '^',
                left: expr,
                right: parseBitwiseANDExpression()
            };
        }

        return expr;
    }

    function parseBitwiseORExpression() {
        var expr = parseBitwiseXORExpression();

        while (match('|')) {
            lex();
            expr = {
                type: Syntax.BinaryExpression,
                operator: '|',
                left: expr,
                right: parseBitwiseXORExpression()
            };
        }

        return expr;
    }

    // 11.11 Binary Logical Operators

    function parseLogicalANDExpression() {
        var expr = parseBitwiseORExpression();

        while (match('&&')) {
            lex();
            expr = {
                type: Syntax.LogicalExpression,
                operator: '&&',
                left: expr,
                right: parseBitwiseORExpression()
            };
        }

        return expr;
    }

    function parseLogicalORExpression() {
        var expr = parseLogicalANDExpression();

        while (match('||')) {
            lex();
            expr = {
                type: Syntax.LogicalExpression,
                operator: '||',
                left: expr,
                right: parseLogicalANDExpression()
            };
        }

        return expr;
    }

    // 11.12 Conditional Operator

    function parseConditionalExpression() {
        var expr, previousAllowIn, consequent;

        expr = parseLogicalORExpression();

        if (match('?')) {
            lex();
            previousAllowIn = state.allowIn;
            state.allowIn = true;
            consequent = parseAssignmentExpression();
            state.allowIn = previousAllowIn;
            expect(':');

            expr = {
                type: Syntax.ConditionalExpression,
                test: expr,
                consequent: consequent,
                alternate: parseAssignmentExpression()
            };
        }

        return expr;
    }

    // 11.13 Assignment Operators

    function parseAssignmentExpression() {
        var token, expr;

        token = lookahead();
        expr = parseConditionalExpression();

        if (matchAssign()) {
            // LeftHandSideExpression
            if (!isLeftHandSide(expr)) {
                throwError({}, Messages.InvalidLHSInAssignment);
            }

            // 11.13.1
            if (strict && expr.type === Syntax.Identifier && isRestrictedWord(expr.name)) {
                throwErrorTolerant(token, Messages.StrictLHSAssignment);
            }

            expr = {
                type: Syntax.AssignmentExpression,
                operator: lex().value,
                left: expr,
                right: parseAssignmentExpression()
            };
        }

        return expr;
    }

    // 11.14 Comma Operator

    function parseExpression() {
        var expr = parseAssignmentExpression();

        if (match(',')) {
            expr = {
                type: Syntax.SequenceExpression,
                expressions: [ expr ]
            };

            while (index < length) {
                if (!match(',')) {
                    break;
                }
                lex();
                expr.expressions.push(parseAssignmentExpression());
            }

        }
        return expr;
    }

    // 12.1 Block

    function parseStatementList() {
        var list = [],
            statement;

        while (index < length) {
            if (match('}')) {
                break;
            }
            statement = parseSourceElement();
            if (typeof statement === 'undefined') {
                break;
            }
            list.push(statement);
        }

        return list;
    }

    function parseBlock() {
        var block;

        expect('{');

        block = parseStatementList();

        expect('}');

        return {
            type: Syntax.BlockStatement,
            body: block
        };
    }

    // 12.2 Variable Statement

    function parseVariableIdentifier() {
        var token = lex();

        if (token.type !== Token.Identifier) {
            throwUnexpected(token);
        }

        return {
            type: Syntax.Identifier,
            name: token.value
        };
    }

    function parseVariableDeclaration(kind) {
        var id = parseVariableIdentifier(),
            init = null;

        // 12.2.1
        if (strict && isRestrictedWord(id.name)) {
            throwErrorTolerant({}, Messages.StrictVarName);
        }

        if (kind === 'const') {
            expect('=');
            init = parseAssignmentExpression();
        } else if (match('=')) {
            lex();
            init = parseAssignmentExpression();
        }

        return {
            type: Syntax.VariableDeclarator,
            id: id,
            init: init
        };
    }

    function parseVariableDeclarationList(kind) {
        var list = [];

        while (index < length) {
            list.push(parseVariableDeclaration(kind));
            if (!match(',')) {
                break;
            }
            lex();
        }

        return list;
    }

    function parseVariableStatement() {
        var declarations;

        expectKeyword('var');

        declarations = parseVariableDeclarationList();

        consumeSemicolon();

        return {
            type: Syntax.VariableDeclaration,
            declarations: declarations,
            kind: 'var'
        };
    }

    // kind may be `const` or `let`
    // Both are experimental and not in the specification yet.
    // see http://wiki.ecmascript.org/doku.php?id=harmony:const
    // and http://wiki.ecmascript.org/doku.php?id=harmony:let
    function parseConstLetDeclaration(kind) {
        var declarations;

        expectKeyword(kind);

        declarations = parseVariableDeclarationList(kind);

        consumeSemicolon();

        return {
            type: Syntax.VariableDeclaration,
            declarations: declarations,
            kind: kind
        };
    }

    // 12.3 Empty Statement

    function parseEmptyStatement() {
        expect(';');

        return {
            type: Syntax.EmptyStatement
        };
    }

    // 12.4 Expression Statement

    function parseExpressionStatement() {
        var expr = parseExpression();

        consumeSemicolon();

        return {
            type: Syntax.ExpressionStatement,
            expression: expr
        };
    }

    // 12.5 If statement

    function parseIfStatement() {
        var test, consequent, alternate;

        expectKeyword('if');

        expect('(');

        test = parseExpression();

        expect(')');

        consequent = parseStatement();

        if (matchKeyword('else')) {
            lex();
            alternate = parseStatement();
        } else {
            alternate = null;
        }

        return {
            type: Syntax.IfStatement,
            test: test,
            consequent: consequent,
            alternate: alternate
        };
    }

    // 12.6 Iteration Statements

    function parseDoWhileStatement() {
        var body, test, oldInIteration;

        expectKeyword('do');

        oldInIteration = state.inIteration;
        state.inIteration = true;

        body = parseStatement();

        state.inIteration = oldInIteration;

        expectKeyword('while');

        expect('(');

        test = parseExpression();

        expect(')');

        if (match(';')) {
            lex();
        }

        return {
            type: Syntax.DoWhileStatement,
            body: body,
            test: test
        };
    }

    function parseWhileStatement() {
        var test, body, oldInIteration;

        expectKeyword('while');

        expect('(');

        test = parseExpression();

        expect(')');

        oldInIteration = state.inIteration;
        state.inIteration = true;

        body = parseStatement();

        state.inIteration = oldInIteration;

        return {
            type: Syntax.WhileStatement,
            test: test,
            body: body
        };
    }

    function parseForVariableDeclaration() {
        var token = lex();

        return {
            type: Syntax.VariableDeclaration,
            declarations: parseVariableDeclarationList(),
            kind: token.value
        };
    }

    function parseForStatement() {
        var init, test, update, left, right, body, oldInIteration;

        init = test = update = null;

        expectKeyword('for');

        expect('(');

        if (match(';')) {
            lex();
        } else {
            if (matchKeyword('var') || matchKeyword('let')) {
                state.allowIn = false;
                init = parseForVariableDeclaration();
                state.allowIn = true;

                if (init.declarations.length === 1 && matchKeyword('in')) {
                    lex();
                    left = init;
                    right = parseExpression();
                    init = null;
                }
            } else {
                state.allowIn = false;
                init = parseExpression();
                state.allowIn = true;

                if (matchKeyword('in')) {
                    // LeftHandSideExpression
                    if (!isLeftHandSide(init)) {
                        throwError({}, Messages.InvalidLHSInForIn);
                    }

                    lex();
                    left = init;
                    right = parseExpression();
                    init = null;
                }
            }

            if (typeof left === 'undefined') {
                expect(';');
            }
        }

        if (typeof left === 'undefined') {

            if (!match(';')) {
                test = parseExpression();
            }
            expect(';');

            if (!match(')')) {
                update = parseExpression();
            }
        }

        expect(')');

        oldInIteration = state.inIteration;
        state.inIteration = true;

        body = parseStatement();

        state.inIteration = oldInIteration;

        if (typeof left === 'undefined') {
            return {
                type: Syntax.ForStatement,
                init: init,
                test: test,
                update: update,
                body: body
            };
        }

        return {
            type: Syntax.ForInStatement,
            left: left,
            right: right,
            body: body,
            each: false
        };
    }

    // 12.7 The continue statement

    function parseContinueStatement() {
        var token, label = null;

        expectKeyword('continue');

        // Optimize the most common form: 'continue;'.
        if (source[index] === ';') {
            lex();

            if (!state.inIteration) {
                throwError({}, Messages.IllegalContinue);
            }

            return {
                type: Syntax.ContinueStatement,
                label: null
            };
        }

        if (peekLineTerminator()) {
            if (!state.inIteration) {
                throwError({}, Messages.IllegalContinue);
            }

            return {
                type: Syntax.ContinueStatement,
                label: null
            };
        }

        token = lookahead();
        if (token.type === Token.Identifier) {
            label = parseVariableIdentifier();

            if (!Object.prototype.hasOwnProperty.call(state.labelSet, label.name)) {
                throwError({}, Messages.UnknownLabel, label.name);
            }
        }

        consumeSemicolon();

        if (label === null && !state.inIteration) {
            throwError({}, Messages.IllegalContinue);
        }

        return {
            type: Syntax.ContinueStatement,
            label: label
        };
    }

    // 12.8 The break statement

    function parseBreakStatement() {
        var token, label = null;

        expectKeyword('break');

        // Optimize the most common form: 'break;'.
        if (source[index] === ';') {
            lex();

            if (!(state.inIteration || state.inSwitch)) {
                throwError({}, Messages.IllegalBreak);
            }

            return {
                type: Syntax.BreakStatement,
                label: null
            };
        }

        if (peekLineTerminator()) {
            if (!(state.inIteration || state.inSwitch)) {
                throwError({}, Messages.IllegalBreak);
            }

            return {
                type: Syntax.BreakStatement,
                label: null
            };
        }

        token = lookahead();
        if (token.type === Token.Identifier) {
            label = parseVariableIdentifier();

            if (!Object.prototype.hasOwnProperty.call(state.labelSet, label.name)) {
                throwError({}, Messages.UnknownLabel, label.name);
            }
        }

        consumeSemicolon();

        if (label === null && !(state.inIteration || state.inSwitch)) {
            throwError({}, Messages.IllegalBreak);
        }

        return {
            type: Syntax.BreakStatement,
            label: label
        };
    }

    // 12.9 The return statement

    function parseReturnStatement() {
        var token, argument = null;

        expectKeyword('return');

        if (!state.inFunctionBody) {
            throwErrorTolerant({}, Messages.IllegalReturn);
        }

        // 'return' followed by a space and an identifier is very common.
        if (source[index] === ' ') {
            if (isIdentifierStart(source[index + 1])) {
                argument = parseExpression();
                consumeSemicolon();
                return {
                    type: Syntax.ReturnStatement,
                    argument: argument
                };
            }
        }

        if (peekLineTerminator()) {
            return {
                type: Syntax.ReturnStatement,
                argument: null
            };
        }

        if (!match(';')) {
            token = lookahead();
            if (!match('}') && token.type !== Token.EOF) {
                argument = parseExpression();
            }
        }

        consumeSemicolon();

        return {
            type: Syntax.ReturnStatement,
            argument: argument
        };
    }

    // 12.10 The with statement

    function parseWithStatement() {
        var object, body;

        if (strict) {
            throwErrorTolerant({}, Messages.StrictModeWith);
        }

        expectKeyword('with');

        expect('(');

        object = parseExpression();

        expect(')');

        body = parseStatement();

        return {
            type: Syntax.WithStatement,
            object: object,
            body: body
        };
    }

    // 12.10 The swith statement

    function parseSwitchCase() {
        var test,
            consequent = [],
            statement;

        if (matchKeyword('default')) {
            lex();
            test = null;
        } else {
            expectKeyword('case');
            test = parseExpression();
        }
        expect(':');

        while (index < length) {
            if (match('}') || matchKeyword('default') || matchKeyword('case')) {
                break;
            }
            statement = parseStatement();
            if (typeof statement === 'undefined') {
                break;
            }
            consequent.push(statement);
        }

        return {
            type: Syntax.SwitchCase,
            test: test,
            consequent: consequent
        };
    }

    function parseSwitchStatement() {
        var discriminant, cases, clause, oldInSwitch, defaultFound;

        expectKeyword('switch');

        expect('(');

        discriminant = parseExpression();

        expect(')');

        expect('{');

        if (match('}')) {
            lex();
            return {
                type: Syntax.SwitchStatement,
                discriminant: discriminant
            };
        }

        cases = [];

        oldInSwitch = state.inSwitch;
        state.inSwitch = true;
        defaultFound = false;

        while (index < length) {
            if (match('}')) {
                break;
            }
            clause = parseSwitchCase();
            if (clause.test === null) {
                if (defaultFound) {
                    throwError({}, Messages.MultipleDefaultsInSwitch);
                }
                defaultFound = true;
            }
            cases.push(clause);
        }

        state.inSwitch = oldInSwitch;

        expect('}');

        return {
            type: Syntax.SwitchStatement,
            discriminant: discriminant,
            cases: cases
        };
    }

    // 12.13 The throw statement

    function parseThrowStatement() {
        var argument;

        expectKeyword('throw');

        if (peekLineTerminator()) {
            throwError({}, Messages.NewlineAfterThrow);
        }

        argument = parseExpression();

        consumeSemicolon();

        return {
            type: Syntax.ThrowStatement,
            argument: argument
        };
    }

    // 12.14 The try statement

    function parseCatchClause() {
        var param;

        expectKeyword('catch');

        expect('(');
        if (!match(')')) {
            param = parseExpression();
            // 12.14.1
            if (strict && param.type === Syntax.Identifier && isRestrictedWord(param.name)) {
                throwErrorTolerant({}, Messages.StrictCatchVariable);
            }
        }
        expect(')');

        return {
            type: Syntax.CatchClause,
            param: param,
            body: parseBlock()
        };
    }

    function parseTryStatement() {
        var block, handlers = [], finalizer = null;

        expectKeyword('try');

        block = parseBlock();

        if (matchKeyword('catch')) {
            handlers.push(parseCatchClause());
        }

        if (matchKeyword('finally')) {
            lex();
            finalizer = parseBlock();
        }

        if (handlers.length === 0 && !finalizer) {
            throwError({}, Messages.NoCatchOrFinally);
        }

        return {
            type: Syntax.TryStatement,
            block: block,
            guardedHandlers: [],
            handlers: handlers,
            finalizer: finalizer
        };
    }

    // 12.15 The debugger statement

    function parseDebuggerStatement() {
        expectKeyword('debugger');

        consumeSemicolon();

        return {
            type: Syntax.DebuggerStatement
        };
    }

    // 12 Statements

    function parseStatement() {
        var token = lookahead(),
            expr,
            labeledBody;

        if (token.type === Token.EOF) {
            throwUnexpected(token);
        }

        if (token.type === Token.Punctuator) {
            switch (token.value) {
            case ';':
                return parseEmptyStatement();
            case '{':
                return parseBlock();
            case '(':
                return parseExpressionStatement();
            default:
                break;
            }
        }

        if (token.type === Token.Keyword) {
            switch (token.value) {
            case 'break':
                return parseBreakStatement();
            case 'continue':
                return parseContinueStatement();
            case 'debugger':
                return parseDebuggerStatement();
            case 'do':
                return parseDoWhileStatement();
            case 'for':
                return parseForStatement();
            case 'function':
                return parseFunctionDeclaration();
            case 'if':
                return parseIfStatement();
            case 'return':
                return parseReturnStatement();
            case 'switch':
                return parseSwitchStatement();
            case 'throw':
                return parseThrowStatement();
            case 'try':
                return parseTryStatement();
            case 'var':
                return parseVariableStatement();
            case 'while':
                return parseWhileStatement();
            case 'with':
                return parseWithStatement();
            default:
                break;
            }
        }

        expr = parseExpression();

        // 12.12 Labelled Statements
        if ((expr.type === Syntax.Identifier) && match(':')) {
            lex();

            if (Object.prototype.hasOwnProperty.call(state.labelSet, expr.name)) {
                throwError({}, Messages.Redeclaration, 'Label', expr.name);
            }

            state.labelSet[expr.name] = true;
            labeledBody = parseStatement();
            delete state.labelSet[expr.name];

            return {
                type: Syntax.LabeledStatement,
                label: expr,
                body: labeledBody
            };
        }

        consumeSemicolon();

        return {
            type: Syntax.ExpressionStatement,
            expression: expr
        };
    }

    // 13 Function Definition

    function parseFunctionSourceElements() {
        var sourceElement, sourceElements = [], token, directive, firstRestricted,
            oldLabelSet, oldInIteration, oldInSwitch, oldInFunctionBody;

        expect('{');

        while (index < length) {
            token = lookahead();
            if (token.type !== Token.StringLiteral) {
                break;
            }

            sourceElement = parseSourceElement();
            sourceElements.push(sourceElement);
            if (sourceElement.expression.type !== Syntax.Literal) {
                // this is not directive
                break;
            }
            directive = sliceSource(token.range[0] + 1, token.range[1] - 1);
            if (directive === 'use strict') {
                strict = true;
                if (firstRestricted) {
                    throwErrorTolerant(firstRestricted, Messages.StrictOctalLiteral);
                }
            } else {
                if (!firstRestricted && token.octal) {
                    firstRestricted = token;
                }
            }
        }

        oldLabelSet = state.labelSet;
        oldInIteration = state.inIteration;
        oldInSwitch = state.inSwitch;
        oldInFunctionBody = state.inFunctionBody;

        state.labelSet = {};
        state.inIteration = false;
        state.inSwitch = false;
        state.inFunctionBody = true;

        while (index < length) {
            if (match('}')) {
                break;
            }
            sourceElement = parseSourceElement();
            if (typeof sourceElement === 'undefined') {
                break;
            }
            sourceElements.push(sourceElement);
        }

        expect('}');

        state.labelSet = oldLabelSet;
        state.inIteration = oldInIteration;
        state.inSwitch = oldInSwitch;
        state.inFunctionBody = oldInFunctionBody;

        return {
            type: Syntax.BlockStatement,
            body: sourceElements
        };
    }

    function parseFunctionDeclaration() {
        var id, param, params = [], body, token, stricted, firstRestricted, message, previousStrict, paramSet;

        expectKeyword('function');
        token = lookahead();
        id = parseVariableIdentifier();
        if (strict) {
            if (isRestrictedWord(token.value)) {
                throwErrorTolerant(token, Messages.StrictFunctionName);
            }
        } else {
            if (isRestrictedWord(token.value)) {
                firstRestricted = token;
                message = Messages.StrictFunctionName;
            } else if (isStrictModeReservedWord(token.value)) {
                firstRestricted = token;
                message = Messages.StrictReservedWord;
            }
        }

        expect('(');

        if (!match(')')) {
            paramSet = {};
            while (index < length) {
                token = lookahead();
                param = parseVariableIdentifier();
                if (strict) {
                    if (isRestrictedWord(token.value)) {
                        stricted = token;
                        message = Messages.StrictParamName;
                    }
                    if (Object.prototype.hasOwnProperty.call(paramSet, token.value)) {
                        stricted = token;
                        message = Messages.StrictParamDupe;
                    }
                } else if (!firstRestricted) {
                    if (isRestrictedWord(token.value)) {
                        firstRestricted = token;
                        message = Messages.StrictParamName;
                    } else if (isStrictModeReservedWord(token.value)) {
                        firstRestricted = token;
                        message = Messages.StrictReservedWord;
                    } else if (Object.prototype.hasOwnProperty.call(paramSet, token.value)) {
                        firstRestricted = token;
                        message = Messages.StrictParamDupe;
                    }
                }
                params.push(param);
                paramSet[param.name] = true;
                if (match(')')) {
                    break;
                }
                expect(',');
            }
        }

        expect(')');

        previousStrict = strict;
        body = parseFunctionSourceElements();
        if (strict && firstRestricted) {
            throwError(firstRestricted, message);
        }
        if (strict && stricted) {
            throwErrorTolerant(stricted, message);
        }
        strict = previousStrict;

        return {
            type: Syntax.FunctionDeclaration,
            id: id,
            params: params,
            defaults: [],
            body: body,
            rest: null,
            generator: false,
            expression: false
        };
    }

    function parseFunctionExpression() {
        var token, id = null, stricted, firstRestricted, message, param, params = [], body, previousStrict, paramSet;

        expectKeyword('function');

        if (!match('(')) {
            token = lookahead();
            id = parseVariableIdentifier();
            if (strict) {
                if (isRestrictedWord(token.value)) {
                    throwErrorTolerant(token, Messages.StrictFunctionName);
                }
            } else {
                if (isRestrictedWord(token.value)) {
                    firstRestricted = token;
                    message = Messages.StrictFunctionName;
                } else if (isStrictModeReservedWord(token.value)) {
                    firstRestricted = token;
                    message = Messages.StrictReservedWord;
                }
            }
        }

        expect('(');

        if (!match(')')) {
            paramSet = {};
            while (index < length) {
                token = lookahead();
                param = parseVariableIdentifier();
                if (strict) {
                    if (isRestrictedWord(token.value)) {
                        stricted = token;
                        message = Messages.StrictParamName;
                    }
                    if (Object.prototype.hasOwnProperty.call(paramSet, token.value)) {
                        stricted = token;
                        message = Messages.StrictParamDupe;
                    }
                } else if (!firstRestricted) {
                    if (isRestrictedWord(token.value)) {
                        firstRestricted = token;
                        message = Messages.StrictParamName;
                    } else if (isStrictModeReservedWord(token.value)) {
                        firstRestricted = token;
                        message = Messages.StrictReservedWord;
                    } else if (Object.prototype.hasOwnProperty.call(paramSet, token.value)) {
                        firstRestricted = token;
                        message = Messages.StrictParamDupe;
                    }
                }
                params.push(param);
                paramSet[param.name] = true;
                if (match(')')) {
                    break;
                }
                expect(',');
            }
        }

        expect(')');

        previousStrict = strict;
        body = parseFunctionSourceElements();
        if (strict && firstRestricted) {
            throwError(firstRestricted, message);
        }
        if (strict && stricted) {
            throwErrorTolerant(stricted, message);
        }
        strict = previousStrict;

        return {
            type: Syntax.FunctionExpression,
            id: id,
            params: params,
            defaults: [],
            body: body,
            rest: null,
            generator: false,
            expression: false
        };
    }

    // 14 Program

    function parseSourceElement() {
        var token = lookahead();

        if (token.type === Token.Keyword) {
            switch (token.value) {
            case 'const':
            case 'let':
                return parseConstLetDeclaration(token.value);
            case 'function':
                return parseFunctionDeclaration();
            default:
                return parseStatement();
            }
        }

        if (token.type !== Token.EOF) {
            return parseStatement();
        }
    }

    function parseSourceElements() {
        var sourceElement, sourceElements = [], token, directive, firstRestricted;

        while (index < length) {
            token = lookahead();
            if (token.type !== Token.StringLiteral) {
                break;
            }

            sourceElement = parseSourceElement();
            sourceElements.push(sourceElement);
            if (sourceElement.expression.type !== Syntax.Literal) {
                // this is not directive
                break;
            }
            directive = sliceSource(token.range[0] + 1, token.range[1] - 1);
            if (directive === 'use strict') {
                strict = true;
                if (firstRestricted) {
                    throwErrorTolerant(firstRestricted, Messages.StrictOctalLiteral);
                }
            } else {
                if (!firstRestricted && token.octal) {
                    firstRestricted = token;
                }
            }
        }

        while (index < length) {
            sourceElement = parseSourceElement();
            if (typeof sourceElement === 'undefined') {
                break;
            }
            sourceElements.push(sourceElement);
        }
        return sourceElements;
    }

    function parseProgram() {
        var program;
        strict = false;
        program = {
            type: Syntax.Program,
            body: parseSourceElements()
        };
        return program;
    }

    // The following functions are needed only when the option to preserve
    // the comments is active.

    function addComment(type, value, start, end, loc) {
        assert(typeof start === 'number', 'Comment must have valid position');

        // Because the way the actual token is scanned, often the comments
        // (if any) are skipped twice during the lexical analysis.
        // Thus, we need to skip adding a comment if the comment array already
        // handled it.
        if (extra.comments.length > 0) {
            if (extra.comments[extra.comments.length - 1].range[1] > start) {
                return;
            }
        }

        extra.comments.push({
            type: type,
            value: value,
            range: [start, end],
            loc: loc
        });
    }

    function scanComment() {
        var comment, ch, loc, start, blockComment, lineComment;

        comment = '';
        blockComment = false;
        lineComment = false;

        while (index < length) {
            ch = source[index];

            if (lineComment) {
                ch = source[index++];
                if (isLineTerminator(ch)) {
                    loc.end = {
                        line: lineNumber,
                        column: index - lineStart - 1
                    };
                    lineComment = false;
                    addComment('Line', comment, start, index - 1, loc);
                    if (ch === '\r' && source[index] === '\n') {
                        ++index;
                    }
                    ++lineNumber;
                    lineStart = index;
                    comment = '';
                } else if (index >= length) {
                    lineComment = false;
                    comment += ch;
                    loc.end = {
                        line: lineNumber,
                        column: length - lineStart
                    };
                    addComment('Line', comment, start, length, loc);
                } else {
                    comment += ch;
                }
            } else if (blockComment) {
                if (isLineTerminator(ch)) {
                    if (ch === '\r' && source[index + 1] === '\n') {
                        ++index;
                        comment += '\r\n';
                    } else {
                        comment += ch;
                    }
                    ++lineNumber;
                    ++index;
                    lineStart = index;
                    if (index >= length) {
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }
                } else {
                    ch = source[index++];
                    if (index >= length) {
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }
                    comment += ch;
                    if (ch === '*') {
                        ch = source[index];
                        if (ch === '/') {
                            comment = comment.substr(0, comment.length - 1);
                            blockComment = false;
                            ++index;
                            loc.end = {
                                line: lineNumber,
                                column: index - lineStart
                            };
                            addComment('Block', comment, start, index, loc);
                            comment = '';
                        }
                    }
                }
            } else if (ch === '/') {
                ch = source[index + 1];
                if (ch === '/') {
                    loc = {
                        start: {
                            line: lineNumber,
                            column: index - lineStart
                        }
                    };
                    start = index;
                    index += 2;
                    lineComment = true;
                    if (index >= length) {
                        loc.end = {
                            line: lineNumber,
                            column: index - lineStart
                        };
                        lineComment = false;
                        addComment('Line', comment, start, index, loc);
                    }
                } else if (ch === '*') {
                    start = index;
                    index += 2;
                    blockComment = true;
                    loc = {
                        start: {
                            line: lineNumber,
                            column: index - lineStart - 2
                        }
                    };
                    if (index >= length) {
                        throwError({}, Messages.UnexpectedToken, 'ILLEGAL');
                    }
                } else {
                    break;
                }
            } else if (isWhiteSpace(ch)) {
                ++index;
            } else if (isLineTerminator(ch)) {
                ++index;
                if (ch ===  '\r' && source[index] === '\n') {
                    ++index;
                }
                ++lineNumber;
                lineStart = index;
            } else {
                break;
            }
        }
    }

    function filterCommentLocation() {
        var i, entry, comment, comments = [];

        for (i = 0; i < extra.comments.length; ++i) {
            entry = extra.comments[i];
            comment = {
                type: entry.type,
                value: entry.value
            };
            if (extra.range) {
                comment.range = entry.range;
            }
            if (extra.loc) {
                comment.loc = entry.loc;
            }
            comments.push(comment);
        }

        extra.comments = comments;
    }

    function collectToken() {
        var start, loc, token, range, value;

        skipComment();
        start = index;
        loc = {
            start: {
                line: lineNumber,
                column: index - lineStart
            }
        };

        token = extra.advance();
        loc.end = {
            line: lineNumber,
            column: index - lineStart
        };

        if (token.type !== Token.EOF) {
            range = [token.range[0], token.range[1]];
            value = sliceSource(token.range[0], token.range[1]);
            extra.tokens.push({
                type: TokenName[token.type],
                value: value,
                range: range,
                loc: loc
            });
        }

        return token;
    }

    function collectRegex() {
        var pos, loc, regex, token;

        skipComment();

        pos = index;
        loc = {
            start: {
                line: lineNumber,
                column: index - lineStart
            }
        };

        regex = extra.scanRegExp();
        loc.end = {
            line: lineNumber,
            column: index - lineStart
        };

        // Pop the previous token, which is likely '/' or '/='
        if (extra.tokens.length > 0) {
            token = extra.tokens[extra.tokens.length - 1];
            if (token.range[0] === pos && token.type === 'Punctuator') {
                if (token.value === '/' || token.value === '/=') {
                    extra.tokens.pop();
                }
            }
        }

        extra.tokens.push({
            type: 'RegularExpression',
            value: regex.literal,
            range: [pos, index],
            loc: loc
        });

        return regex;
    }

    function filterTokenLocation() {
        var i, entry, token, tokens = [];

        for (i = 0; i < extra.tokens.length; ++i) {
            entry = extra.tokens[i];
            token = {
                type: entry.type,
                value: entry.value
            };
            if (extra.range) {
                token.range = entry.range;
            }
            if (extra.loc) {
                token.loc = entry.loc;
            }
            tokens.push(token);
        }

        extra.tokens = tokens;
    }

    function createLiteral(token) {
        return {
            type: Syntax.Literal,
            value: token.value
        };
    }

    function createRawLiteral(token) {
        return {
            type: Syntax.Literal,
            value: token.value,
            raw: sliceSource(token.range[0], token.range[1])
        };
    }

    function createLocationMarker() {
        var marker = {};

        marker.range = [index, index];
        marker.loc = {
            start: {
                line: lineNumber,
                column: index - lineStart
            },
            end: {
                line: lineNumber,
                column: index - lineStart
            }
        };

        marker.end = function () {
            this.range[1] = index;
            this.loc.end.line = lineNumber;
            this.loc.end.column = index - lineStart;
        };

        marker.applyGroup = function (node) {
            if (extra.range) {
                node.groupRange = [this.range[0], this.range[1]];
            }
            if (extra.loc) {
                node.groupLoc = {
                    start: {
                        line: this.loc.start.line,
                        column: this.loc.start.column
                    },
                    end: {
                        line: this.loc.end.line,
                        column: this.loc.end.column
                    }
                };
            }
        };

        marker.apply = function (node) {
            if (extra.range) {
                node.range = [this.range[0], this.range[1]];
            }
            if (extra.loc) {
                node.loc = {
                    start: {
                        line: this.loc.start.line,
                        column: this.loc.start.column
                    },
                    end: {
                        line: this.loc.end.line,
                        column: this.loc.end.column
                    }
                };
            }
        };

        return marker;
    }

    function trackGroupExpression() {
        var marker, expr;

        skipComment();
        marker = createLocationMarker();
        expect('(');

        expr = parseExpression();

        expect(')');

        marker.end();
        marker.applyGroup(expr);

        return expr;
    }

    function trackLeftHandSideExpression() {
        var marker, expr;

        skipComment();
        marker = createLocationMarker();

        expr = matchKeyword('new') ? parseNewExpression() : parsePrimaryExpression();

        while (match('.') || match('[')) {
            if (match('[')) {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: true,
                    object: expr,
                    property: parseComputedMember()
                };
                marker.end();
                marker.apply(expr);
            } else {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: false,
                    object: expr,
                    property: parseNonComputedMember()
                };
                marker.end();
                marker.apply(expr);
            }
        }

        return expr;
    }

    function trackLeftHandSideExpressionAllowCall() {
        var marker, expr;

        skipComment();
        marker = createLocationMarker();

        expr = matchKeyword('new') ? parseNewExpression() : parsePrimaryExpression();

        while (match('.') || match('[') || match('(')) {
            if (match('(')) {
                expr = {
                    type: Syntax.CallExpression,
                    callee: expr,
                    'arguments': parseArguments()
                };
                marker.end();
                marker.apply(expr);
            } else if (match('[')) {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: true,
                    object: expr,
                    property: parseComputedMember()
                };
                marker.end();
                marker.apply(expr);
            } else {
                expr = {
                    type: Syntax.MemberExpression,
                    computed: false,
                    object: expr,
                    property: parseNonComputedMember()
                };
                marker.end();
                marker.apply(expr);
            }
        }

        return expr;
    }

    function filterGroup(node) {
        var n, i, entry;

        n = (Object.prototype.toString.apply(node) === '[object Array]') ? [] : {};
        for (i in node) {
            if (node.hasOwnProperty(i) && i !== 'groupRange' && i !== 'groupLoc') {
                entry = node[i];
                if (entry === null || typeof entry !== 'object' || entry instanceof RegExp) {
                    n[i] = entry;
                } else {
                    n[i] = filterGroup(entry);
                }
            }
        }
        return n;
    }

    function wrapTrackingFunction(range, loc) {

        return function (parseFunction) {

            function isBinary(node) {
                return node.type === Syntax.LogicalExpression ||
                    node.type === Syntax.BinaryExpression;
            }

            function visit(node) {
                var start, end;

                if (isBinary(node.left)) {
                    visit(node.left);
                }
                if (isBinary(node.right)) {
                    visit(node.right);
                }

                if (range) {
                    if (node.left.groupRange || node.right.groupRange) {
                        start = node.left.groupRange ? node.left.groupRange[0] : node.left.range[0];
                        end = node.right.groupRange ? node.right.groupRange[1] : node.right.range[1];
                        node.range = [start, end];
                    } else if (typeof node.range === 'undefined') {
                        start = node.left.range[0];
                        end = node.right.range[1];
                        node.range = [start, end];
                    }
                }
                if (loc) {
                    if (node.left.groupLoc || node.right.groupLoc) {
                        start = node.left.groupLoc ? node.left.groupLoc.start : node.left.loc.start;
                        end = node.right.groupLoc ? node.right.groupLoc.end : node.right.loc.end;
                        node.loc = {
                            start: start,
                            end: end
                        };
                    } else if (typeof node.loc === 'undefined') {
                        node.loc = {
                            start: node.left.loc.start,
                            end: node.right.loc.end
                        };
                    }
                }
            }

            return function () {
                var marker, node;

                skipComment();

                marker = createLocationMarker();
                node = parseFunction.apply(null, arguments);
                marker.end();

                if (range && typeof node.range === 'undefined') {
                    marker.apply(node);
                }

                if (loc && typeof node.loc === 'undefined') {
                    marker.apply(node);
                }

                if (isBinary(node)) {
                    visit(node);
                }

                return node;
            };
        };
    }

    function patch() {

        var wrapTracking;

        if (extra.comments) {
            extra.skipComment = skipComment;
            skipComment = scanComment;
        }

        if (extra.raw) {
            extra.createLiteral = createLiteral;
            createLiteral = createRawLiteral;
        }

        if (extra.range || extra.loc) {

            extra.parseGroupExpression = parseGroupExpression;
            extra.parseLeftHandSideExpression = parseLeftHandSideExpression;
            extra.parseLeftHandSideExpressionAllowCall = parseLeftHandSideExpressionAllowCall;
            parseGroupExpression = trackGroupExpression;
            parseLeftHandSideExpression = trackLeftHandSideExpression;
            parseLeftHandSideExpressionAllowCall = trackLeftHandSideExpressionAllowCall;

            wrapTracking = wrapTrackingFunction(extra.range, extra.loc);

            extra.parseAdditiveExpression = parseAdditiveExpression;
            extra.parseAssignmentExpression = parseAssignmentExpression;
            extra.parseBitwiseANDExpression = parseBitwiseANDExpression;
            extra.parseBitwiseORExpression = parseBitwiseORExpression;
            extra.parseBitwiseXORExpression = parseBitwiseXORExpression;
            extra.parseBlock = parseBlock;
            extra.parseFunctionSourceElements = parseFunctionSourceElements;
            extra.parseCatchClause = parseCatchClause;
            extra.parseComputedMember = parseComputedMember;
            extra.parseConditionalExpression = parseConditionalExpression;
            extra.parseConstLetDeclaration = parseConstLetDeclaration;
            extra.parseEqualityExpression = parseEqualityExpression;
            extra.parseExpression = parseExpression;
            extra.parseForVariableDeclaration = parseForVariableDeclaration;
            extra.parseFunctionDeclaration = parseFunctionDeclaration;
            extra.parseFunctionExpression = parseFunctionExpression;
            extra.parseLogicalANDExpression = parseLogicalANDExpression;
            extra.parseLogicalORExpression = parseLogicalORExpression;
            extra.parseMultiplicativeExpression = parseMultiplicativeExpression;
            extra.parseNewExpression = parseNewExpression;
            extra.parseNonComputedProperty = parseNonComputedProperty;
            extra.parseObjectProperty = parseObjectProperty;
            extra.parseObjectPropertyKey = parseObjectPropertyKey;
            extra.parsePostfixExpression = parsePostfixExpression;
            extra.parsePrimaryExpression = parsePrimaryExpression;
            extra.parseProgram = parseProgram;
            extra.parsePropertyFunction = parsePropertyFunction;
            extra.parseRelationalExpression = parseRelationalExpression;
            extra.parseStatement = parseStatement;
            extra.parseShiftExpression = parseShiftExpression;
            extra.parseSwitchCase = parseSwitchCase;
            extra.parseUnaryExpression = parseUnaryExpression;
            extra.parseVariableDeclaration = parseVariableDeclaration;
            extra.parseVariableIdentifier = parseVariableIdentifier;

            parseAdditiveExpression = wrapTracking(extra.parseAdditiveExpression);
            parseAssignmentExpression = wrapTracking(extra.parseAssignmentExpression);
            parseBitwiseANDExpression = wrapTracking(extra.parseBitwiseANDExpression);
            parseBitwiseORExpression = wrapTracking(extra.parseBitwiseORExpression);
            parseBitwiseXORExpression = wrapTracking(extra.parseBitwiseXORExpression);
            parseBlock = wrapTracking(extra.parseBlock);
            parseFunctionSourceElements = wrapTracking(extra.parseFunctionSourceElements);
            parseCatchClause = wrapTracking(extra.parseCatchClause);
            parseComputedMember = wrapTracking(extra.parseComputedMember);
            parseConditionalExpression = wrapTracking(extra.parseConditionalExpression);
            parseConstLetDeclaration = wrapTracking(extra.parseConstLetDeclaration);
            parseEqualityExpression = wrapTracking(extra.parseEqualityExpression);
            parseExpression = wrapTracking(extra.parseExpression);
            parseForVariableDeclaration = wrapTracking(extra.parseForVariableDeclaration);
            parseFunctionDeclaration = wrapTracking(extra.parseFunctionDeclaration);
            parseFunctionExpression = wrapTracking(extra.parseFunctionExpression);
            parseLeftHandSideExpression = wrapTracking(parseLeftHandSideExpression);
            parseLogicalANDExpression = wrapTracking(extra.parseLogicalANDExpression);
            parseLogicalORExpression = wrapTracking(extra.parseLogicalORExpression);
            parseMultiplicativeExpression = wrapTracking(extra.parseMultiplicativeExpression);
            parseNewExpression = wrapTracking(extra.parseNewExpression);
            parseNonComputedProperty = wrapTracking(extra.parseNonComputedProperty);
            parseObjectProperty = wrapTracking(extra.parseObjectProperty);
            parseObjectPropertyKey = wrapTracking(extra.parseObjectPropertyKey);
            parsePostfixExpression = wrapTracking(extra.parsePostfixExpression);
            parsePrimaryExpression = wrapTracking(extra.parsePrimaryExpression);
            parseProgram = wrapTracking(extra.parseProgram);
            parsePropertyFunction = wrapTracking(extra.parsePropertyFunction);
            parseRelationalExpression = wrapTracking(extra.parseRelationalExpression);
            parseStatement = wrapTracking(extra.parseStatement);
            parseShiftExpression = wrapTracking(extra.parseShiftExpression);
            parseSwitchCase = wrapTracking(extra.parseSwitchCase);
            parseUnaryExpression = wrapTracking(extra.parseUnaryExpression);
            parseVariableDeclaration = wrapTracking(extra.parseVariableDeclaration);
            parseVariableIdentifier = wrapTracking(extra.parseVariableIdentifier);
        }

        if (typeof extra.tokens !== 'undefined') {
            extra.advance = advance;
            extra.scanRegExp = scanRegExp;

            advance = collectToken;
            scanRegExp = collectRegex;
        }
    }

    function unpatch() {
        if (typeof extra.skipComment === 'function') {
            skipComment = extra.skipComment;
        }

        if (extra.raw) {
            createLiteral = extra.createLiteral;
        }

        if (extra.range || extra.loc) {
            parseAdditiveExpression = extra.parseAdditiveExpression;
            parseAssignmentExpression = extra.parseAssignmentExpression;
            parseBitwiseANDExpression = extra.parseBitwiseANDExpression;
            parseBitwiseORExpression = extra.parseBitwiseORExpression;
            parseBitwiseXORExpression = extra.parseBitwiseXORExpression;
            parseBlock = extra.parseBlock;
            parseFunctionSourceElements = extra.parseFunctionSourceElements;
            parseCatchClause = extra.parseCatchClause;
            parseComputedMember = extra.parseComputedMember;
            parseConditionalExpression = extra.parseConditionalExpression;
            parseConstLetDeclaration = extra.parseConstLetDeclaration;
            parseEqualityExpression = extra.parseEqualityExpression;
            parseExpression = extra.parseExpression;
            parseForVariableDeclaration = extra.parseForVariableDeclaration;
            parseFunctionDeclaration = extra.parseFunctionDeclaration;
            parseFunctionExpression = extra.parseFunctionExpression;
            parseGroupExpression = extra.parseGroupExpression;
            parseLeftHandSideExpression = extra.parseLeftHandSideExpression;
            parseLeftHandSideExpressionAllowCall = extra.parseLeftHandSideExpressionAllowCall;
            parseLogicalANDExpression = extra.parseLogicalANDExpression;
            parseLogicalORExpression = extra.parseLogicalORExpression;
            parseMultiplicativeExpression = extra.parseMultiplicativeExpression;
            parseNewExpression = extra.parseNewExpression;
            parseNonComputedProperty = extra.parseNonComputedProperty;
            parseObjectProperty = extra.parseObjectProperty;
            parseObjectPropertyKey = extra.parseObjectPropertyKey;
            parsePrimaryExpression = extra.parsePrimaryExpression;
            parsePostfixExpression = extra.parsePostfixExpression;
            parseProgram = extra.parseProgram;
            parsePropertyFunction = extra.parsePropertyFunction;
            parseRelationalExpression = extra.parseRelationalExpression;
            parseStatement = extra.parseStatement;
            parseShiftExpression = extra.parseShiftExpression;
            parseSwitchCase = extra.parseSwitchCase;
            parseUnaryExpression = extra.parseUnaryExpression;
            parseVariableDeclaration = extra.parseVariableDeclaration;
            parseVariableIdentifier = extra.parseVariableIdentifier;
        }

        if (typeof extra.scanRegExp === 'function') {
            advance = extra.advance;
            scanRegExp = extra.scanRegExp;
        }
    }

    function stringToArray(str) {
        var length = str.length,
            result = [],
            i;
        for (i = 0; i < length; ++i) {
            result[i] = str.charAt(i);
        }
        return result;
    }

    function parse(code, options) {
        var program, toString;

        toString = String;
        if (typeof code !== 'string' && !(code instanceof String)) {
            code = toString(code);
        }

        source = code;
        index = 0;
        lineNumber = (source.length > 0) ? 1 : 0;
        lineStart = 0;
        length = source.length;
        buffer = null;
        state = {
            allowIn: true,
            labelSet: {},
            inFunctionBody: false,
            inIteration: false,
            inSwitch: false
        };

        extra = {};
        if (typeof options !== 'undefined') {
            extra.range = (typeof options.range === 'boolean') && options.range;
            extra.loc = (typeof options.loc === 'boolean') && options.loc;
            extra.raw = (typeof options.raw === 'boolean') && options.raw;
            if (typeof options.tokens === 'boolean' && options.tokens) {
                extra.tokens = [];
            }
            if (typeof options.comment === 'boolean' && options.comment) {
                extra.comments = [];
            }
            if (typeof options.tolerant === 'boolean' && options.tolerant) {
                extra.errors = [];
            }
        }

        if (length > 0) {
            if (typeof source[0] === 'undefined') {
                // Try first to convert to a string. This is good as fast path
                // for old IE which understands string indexing for string
                // literals only and not for string object.
                if (code instanceof String) {
                    source = code.valueOf();
                }

                // Force accessing the characters via an array.
                if (typeof source[0] === 'undefined') {
                    source = stringToArray(code);
                }
            }
        }

        patch();
        try {
            program = parseProgram();
            if (typeof extra.comments !== 'undefined') {
                filterCommentLocation();
                program.comments = extra.comments;
            }
            if (typeof extra.tokens !== 'undefined') {
                filterTokenLocation();
                program.tokens = extra.tokens;
            }
            if (typeof extra.errors !== 'undefined') {
                program.errors = extra.errors;
            }
            if (extra.range || extra.loc) {
                program.body = filterGroup(program.body);
            }
        } catch (e) {
            throw e;
        } finally {
            unpatch();
            extra = {};
        }

        return program;
    }

    // Sync with package.json.
    exports.version = '1.0.2';

    exports.parse = parse;

    // Deep copy.
    exports.Syntax = (function () {
        var name, types = {};

        if (typeof Object.create === 'function') {
            types = Object.create(null);
        }

        for (name in Syntax) {
            if (Syntax.hasOwnProperty(name)) {
                types[name] = Syntax[name];
            }
        }

        if (typeof Object.freeze === 'function') {
            Object.freeze(types);
        }

        return types;
    }());

}));
/* vim: set sw=4 ts=4 et tw=80 : */

},{}],42:[function(require,module,exports){
/*
  Copyright (C) 2012-2013 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012 Ariya Hidayat <ariya.hidayat@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/*jslint vars:false, bitwise:true*/
/*jshint indent:4*/
/*global exports:true, define:true*/
(function (root, factory) {
    'use strict';

    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js,
    // and plain browser loading,
    if (typeof define === 'function' && define.amd) {
        define(['exports'], factory);
    } else if (typeof exports !== 'undefined') {
        factory(exports);
    } else {
        factory((root.estraverse = {}));
    }
}(this, function (exports) {
    'use strict';

    var Syntax,
        isArray,
        VisitorOption,
        VisitorKeys,
        BREAK,
        SKIP;

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        ArrayExpression: 'ArrayExpression',
        ArrowFunctionExpression: 'ArrowFunctionExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ClassBody: 'ClassBody',
        ClassDeclaration: 'ClassDeclaration',
        ClassExpression: 'ClassExpression',
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DebuggerStatement: 'DebuggerStatement',
        DirectiveStatement: 'DirectiveStatement',
        DoWhileStatement: 'DoWhileStatement',
        EmptyStatement: 'EmptyStatement',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForInStatement: 'ForInStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        MethodDefinition: 'MethodDefinition',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        Program: 'Program',
        Property: 'Property',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SwitchStatement: 'SwitchStatement',
        SwitchCase: 'SwitchCase',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement',
        YieldExpression: 'YieldExpression'
    };

    function ignoreJSHintError() { }

    isArray = Array.isArray;
    if (!isArray) {
        isArray = function isArray(array) {
            return Object.prototype.toString.call(array) === '[object Array]';
        };
    }

    function deepCopy(obj) {
        var ret = {}, key, val;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                val = obj[key];
                if (typeof val === 'object' && val !== null) {
                    ret[key] = deepCopy(val);
                } else {
                    ret[key] = val;
                }
            }
        }
        return ret;
    }

    function shallowCopy(obj) {
        var ret = {}, key;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                ret[key] = obj[key];
            }
        }
        return ret;
    }
    ignoreJSHintError(shallowCopy);

    // based on LLVM libc++ upper_bound / lower_bound
    // MIT License

    function upperBound(array, func) {
        var diff, len, i, current;

        len = array.length;
        i = 0;

        while (len) {
            diff = len >>> 1;
            current = i + diff;
            if (func(array[current])) {
                len = diff;
            } else {
                i = current + 1;
                len -= diff + 1;
            }
        }
        return i;
    }

    function lowerBound(array, func) {
        var diff, len, i, current;

        len = array.length;
        i = 0;

        while (len) {
            diff = len >>> 1;
            current = i + diff;
            if (func(array[current])) {
                i = current + 1;
                len -= diff + 1;
            } else {
                len = diff;
            }
        }
        return i;
    }
    ignoreJSHintError(lowerBound);

    VisitorKeys = {
        AssignmentExpression: ['left', 'right'],
        ArrayExpression: ['elements'],
        ArrowFunctionExpression: ['params', 'body'],
        BlockStatement: ['body'],
        BinaryExpression: ['left', 'right'],
        BreakStatement: ['label'],
        CallExpression: ['callee', 'arguments'],
        CatchClause: ['param', 'body'],
        ClassBody: ['body'],
        ClassDeclaration: ['id', 'body', 'superClass'],
        ClassExpression: ['id', 'body', 'superClass'],
        ConditionalExpression: ['test', 'consequent', 'alternate'],
        ContinueStatement: ['label'],
        DebuggerStatement: [],
        DirectiveStatement: [],
        DoWhileStatement: ['body', 'test'],
        EmptyStatement: [],
        ExpressionStatement: ['expression'],
        ForStatement: ['init', 'test', 'update', 'body'],
        ForInStatement: ['left', 'right', 'body'],
        FunctionDeclaration: ['id', 'params', 'body'],
        FunctionExpression: ['id', 'params', 'body'],
        Identifier: [],
        IfStatement: ['test', 'consequent', 'alternate'],
        Literal: [],
        LabeledStatement: ['label', 'body'],
        LogicalExpression: ['left', 'right'],
        MemberExpression: ['object', 'property'],
        MethodDefinition: ['key', 'value'],
        NewExpression: ['callee', 'arguments'],
        ObjectExpression: ['properties'],
        Program: ['body'],
        Property: ['key', 'value'],
        ReturnStatement: ['argument'],
        SequenceExpression: ['expressions'],
        SwitchStatement: ['discriminant', 'cases'],
        SwitchCase: ['test', 'consequent'],
        ThisExpression: [],
        ThrowStatement: ['argument'],
        TryStatement: ['block', 'handlers', 'handler', 'guardedHandlers', 'finalizer'],
        UnaryExpression: ['argument'],
        UpdateExpression: ['argument'],
        VariableDeclaration: ['declarations'],
        VariableDeclarator: ['id', 'init'],
        WhileStatement: ['test', 'body'],
        WithStatement: ['object', 'body'],
        YieldExpression: ['argument']
    };

    // unique id
    BREAK = {};
    SKIP = {};

    VisitorOption = {
        Break: BREAK,
        Skip: SKIP
    };

    function Reference(parent, key) {
        this.parent = parent;
        this.key = key;
    }

    Reference.prototype.replace = function replace(node) {
        this.parent[this.key] = node;
    };

    function Element(node, path, wrap, ref) {
        this.node = node;
        this.path = path;
        this.wrap = wrap;
        this.ref = ref;
    }

    function Controller() { }

    // API:
    // return property path array from root to current node
    Controller.prototype.path = function path() {
        var i, iz, j, jz, result, element;

        function addToPath(result, path) {
            if (isArray(path)) {
                for (j = 0, jz = path.length; j < jz; ++j) {
                    result.push(path[j]);
                }
            } else {
                result.push(path);
            }
        }

        // root node
        if (!this.__current.path) {
            return null;
        }

        // first node is sentinel, second node is root element
        result = [];
        for (i = 2, iz = this.__leavelist.length; i < iz; ++i) {
            element = this.__leavelist[i];
            addToPath(result, element.path);
        }
        addToPath(result, this.__current.path);
        return result;
    };

    // API:
    // return array of parent elements
    Controller.prototype.parents = function parents() {
        var i, iz, result;

        // first node is sentinel
        result = [];
        for (i = 1, iz = this.__leavelist.length; i < iz; ++i) {
            result.push(this.__leavelist[i].node);
        }

        return result;
    };

    // API:
    // return current node
    Controller.prototype.current = function current() {
        return this.__current.node;
    };

    Controller.prototype.__execute = function __execute(callback, element) {
        var previous, result;

        result = undefined;

        previous  = this.__current;
        this.__current = element;
        this.__state = null;
        if (callback) {
            result = callback.call(this, element.node, this.__leavelist[this.__leavelist.length - 1].node);
        }
        this.__current = previous;

        return result;
    };

    // API:
    // notify control skip / break
    Controller.prototype.notify = function notify(flag) {
        this.__state = flag;
    };

    // API:
    // skip child nodes of current node
    Controller.prototype.skip = function () {
        this.notify(SKIP);
    };

    // API:
    // break traversals
    Controller.prototype['break'] = function () {
        this.notify(BREAK);
    };

    Controller.prototype.__initialize = function(root, visitor) {
        this.visitor = visitor;
        this.root = root;
        this.__worklist = [];
        this.__leavelist = [];
        this.__current = null;
        this.__state = null;
    };

    Controller.prototype.traverse = function traverse(root, visitor) {
        var worklist,
            leavelist,
            element,
            node,
            nodeType,
            ret,
            key,
            current,
            current2,
            candidates,
            candidate,
            sentinel;

        this.__initialize(root, visitor);

        sentinel = {};

        // reference
        worklist = this.__worklist;
        leavelist = this.__leavelist;

        // initialize
        worklist.push(new Element(root, null, null, null));
        leavelist.push(new Element(null, null, null, null));

        while (worklist.length) {
            element = worklist.pop();

            if (element === sentinel) {
                element = leavelist.pop();

                ret = this.__execute(visitor.leave, element);

                if (this.__state === BREAK || ret === BREAK) {
                    return;
                }
                continue;
            }

            if (element.node) {

                ret = this.__execute(visitor.enter, element);

                if (this.__state === BREAK || ret === BREAK) {
                    return;
                }

                worklist.push(sentinel);
                leavelist.push(element);

                if (this.__state === SKIP || ret === SKIP) {
                    continue;
                }

                node = element.node;
                nodeType = element.wrap || node.type;
                candidates = VisitorKeys[nodeType];

                current = candidates.length;
                while ((current -= 1) >= 0) {
                    key = candidates[current];
                    candidate = node[key];
                    if (!candidate) {
                        continue;
                    }

                    if (!isArray(candidate)) {
                        worklist.push(new Element(candidate, key, null, null));
                        continue;
                    }

                    current2 = candidate.length;
                    while ((current2 -= 1) >= 0) {
                        if (!candidate[current2]) {
                            continue;
                        }
                        if (nodeType === Syntax.ObjectExpression && 'properties' === candidates[current]) {
                            element = new Element(candidate[current2], [key, current2], 'Property', null);
                        } else {
                            element = new Element(candidate[current2], [key, current2], null, null);
                        }
                        worklist.push(element);
                    }
                }
            }
        }
    };

    Controller.prototype.replace = function replace(root, visitor) {
        var worklist,
            leavelist,
            node,
            nodeType,
            target,
            element,
            current,
            current2,
            candidates,
            candidate,
            sentinel,
            outer,
            key;

        this.__initialize(root, visitor);

        sentinel = {};

        // reference
        worklist = this.__worklist;
        leavelist = this.__leavelist;

        // initialize
        outer = {
            root: root
        };
        element = new Element(root, null, null, new Reference(outer, 'root'));
        worklist.push(element);
        leavelist.push(element);

        while (worklist.length) {
            element = worklist.pop();

            if (element === sentinel) {
                element = leavelist.pop();

                target = this.__execute(visitor.leave, element);

                // node may be replaced with null,
                // so distinguish between undefined and null in this place
                if (target !== undefined && target !== BREAK && target !== SKIP) {
                    // replace
                    element.ref.replace(target);
                }

                if (this.__state === BREAK || target === BREAK) {
                    return outer.root;
                }
                continue;
            }

            target = this.__execute(visitor.enter, element);

            // node may be replaced with null,
            // so distinguish between undefined and null in this place
            if (target !== undefined && target !== BREAK && target !== SKIP) {
                // replace
                element.ref.replace(target);
                element.node = target;
            }

            if (this.__state === BREAK || target === BREAK) {
                return outer.root;
            }

            // node may be null
            node = element.node;
            if (!node) {
                continue;
            }

            worklist.push(sentinel);
            leavelist.push(element);

            if (this.__state === SKIP || target === SKIP) {
                continue;
            }

            nodeType = element.wrap || node.type;
            candidates = VisitorKeys[nodeType];

            current = candidates.length;
            while ((current -= 1) >= 0) {
                key = candidates[current];
                candidate = node[key];
                if (!candidate) {
                    continue;
                }

                if (!isArray(candidate)) {
                    worklist.push(new Element(candidate, key, null, new Reference(node, key)));
                    continue;
                }

                current2 = candidate.length;
                while ((current2 -= 1) >= 0) {
                    if (!candidate[current2]) {
                        continue;
                    }
                    if (nodeType === Syntax.ObjectExpression && 'properties' === candidates[current]) {
                        element = new Element(candidate[current2], [key, current2], 'Property', new Reference(candidate, current2));
                    } else {
                        element = new Element(candidate[current2], [key, current2], null, new Reference(candidate, current2));
                    }
                    worklist.push(element);
                }
            }
        }

        return outer.root;
    };

    function traverse(root, visitor) {
        var controller = new Controller();
        return controller.traverse(root, visitor);
    }

    function replace(root, visitor) {
        var controller = new Controller();
        return controller.replace(root, visitor);
    }

    function extendCommentRange(comment, tokens) {
        var target;

        target = upperBound(tokens, function search(token) {
            return token.range[0] > comment.range[0];
        });

        comment.extendedRange = [comment.range[0], comment.range[1]];

        if (target !== tokens.length) {
            comment.extendedRange[1] = tokens[target].range[0];
        }

        target -= 1;
        if (target >= 0) {
            comment.extendedRange[0] = tokens[target].range[1];
        }

        return comment;
    }

    function attachComments(tree, providedComments, tokens) {
        // At first, we should calculate extended comment ranges.
        var comments = [], comment, len, i, cursor;

        if (!tree.range) {
            throw new Error('attachComments needs range information');
        }

        // tokens array is empty, we attach comments to tree as 'leadingComments'
        if (!tokens.length) {
            if (providedComments.length) {
                for (i = 0, len = providedComments.length; i < len; i += 1) {
                    comment = deepCopy(providedComments[i]);
                    comment.extendedRange = [0, tree.range[0]];
                    comments.push(comment);
                }
                tree.leadingComments = comments;
            }
            return tree;
        }

        for (i = 0, len = providedComments.length; i < len; i += 1) {
            comments.push(extendCommentRange(deepCopy(providedComments[i]), tokens));
        }

        // This is based on John Freeman's implementation.
        cursor = 0;
        traverse(tree, {
            enter: function (node) {
                var comment;

                while (cursor < comments.length) {
                    comment = comments[cursor];
                    if (comment.extendedRange[1] > node.range[0]) {
                        break;
                    }

                    if (comment.extendedRange[1] === node.range[0]) {
                        if (!node.leadingComments) {
                            node.leadingComments = [];
                        }
                        node.leadingComments.push(comment);
                        comments.splice(cursor, 1);
                    } else {
                        cursor += 1;
                    }
                }

                // already out of owned node
                if (cursor === comments.length) {
                    return VisitorOption.Break;
                }

                if (comments[cursor].extendedRange[0] > node.range[1]) {
                    return VisitorOption.Skip;
                }
            }
        });

        cursor = 0;
        traverse(tree, {
            leave: function (node) {
                var comment;

                while (cursor < comments.length) {
                    comment = comments[cursor];
                    if (node.range[1] < comment.extendedRange[0]) {
                        break;
                    }

                    if (node.range[1] === comment.extendedRange[0]) {
                        if (!node.trailingComments) {
                            node.trailingComments = [];
                        }
                        node.trailingComments.push(comment);
                        comments.splice(cursor, 1);
                    } else {
                        cursor += 1;
                    }
                }

                // already out of owned node
                if (cursor === comments.length) {
                    return VisitorOption.Break;
                }

                if (comments[cursor].extendedRange[0] > node.range[1]) {
                    return VisitorOption.Skip;
                }
            }
        });

        return tree;
    }

    exports.version = '1.3.2';
    exports.Syntax = Syntax;
    exports.traverse = traverse;
    exports.replace = replace;
    exports.attachComments = attachComments;
    exports.VisitorKeys = VisitorKeys;
    exports.VisitorOption = VisitorOption;
    exports.Controller = Controller;
}));
/* vim: set sw=4 ts=4 et tw=80 : */

},{}],43:[function(require,module,exports){
// http://wiki.commonjs.org/wiki/Unit_Testing/1.0
//
// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// when used in node, this will actually load the util module we depend on
// versus loading the builtin util module as happens otherwise
// this is a bug in node module loading as far as I am concerned
var util = require('util/');

var pSlice = Array.prototype.slice;
var hasOwn = Object.prototype.hasOwnProperty;

// 1. The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

var assert = module.exports = ok;

// 2. The AssertionError is defined in assert.
// new assert.AssertionError({ message: message,
//                             actual: actual,
//                             expected: expected })

assert.AssertionError = function AssertionError(options) {
  this.name = 'AssertionError';
  this.actual = options.actual;
  this.expected = options.expected;
  this.operator = options.operator;
  if (options.message) {
    this.message = options.message;
    this.generatedMessage = false;
  } else {
    this.message = getMessage(this);
    this.generatedMessage = true;
  }
  var stackStartFunction = options.stackStartFunction || fail;

  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, stackStartFunction);
  }
  else {
    // non v8 browsers so we can have a stacktrace
    var err = new Error();
    if (err.stack) {
      var out = err.stack;

      // try to strip useless frames
      var fn_name = stackStartFunction.name;
      var idx = out.indexOf('\n' + fn_name);
      if (idx >= 0) {
        // once we have located the function frame
        // we need to strip out everything before it (and its line)
        var next_line = out.indexOf('\n', idx + 1);
        out = out.substring(next_line + 1);
      }

      this.stack = out;
    }
  }
};

// assert.AssertionError instanceof Error
util.inherits(assert.AssertionError, Error);

function replacer(key, value) {
  if (util.isUndefined(value)) {
    return '' + value;
  }
  if (util.isNumber(value) && (isNaN(value) || !isFinite(value))) {
    return value.toString();
  }
  if (util.isFunction(value) || util.isRegExp(value)) {
    return value.toString();
  }
  return value;
}

function truncate(s, n) {
  if (util.isString(s)) {
    return s.length < n ? s : s.slice(0, n);
  } else {
    return s;
  }
}

function getMessage(self) {
  return truncate(JSON.stringify(self.actual, replacer), 128) + ' ' +
         self.operator + ' ' +
         truncate(JSON.stringify(self.expected, replacer), 128);
}

// At present only the three keys mentioned above are used and
// understood by the spec. Implementations or sub modules can pass
// other keys to the AssertionError's constructor - they will be
// ignored.

// 3. All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided.  All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

function fail(actual, expected, message, operator, stackStartFunction) {
  throw new assert.AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator,
    stackStartFunction: stackStartFunction
  });
}

// EXTENSION! allows for well behaved errors defined elsewhere.
assert.fail = fail;

// 4. Pure assertion tests whether a value is truthy, as determined
// by !!guard.
// assert.ok(guard, message_opt);
// This statement is equivalent to assert.equal(true, !!guard,
// message_opt);. To test strictly for the value true, use
// assert.strictEqual(true, guard, message_opt);.

function ok(value, message) {
  if (!value) fail(value, true, message, '==', assert.ok);
}
assert.ok = ok;

// 5. The equality assertion tests shallow, coercive equality with
// ==.
// assert.equal(actual, expected, message_opt);

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
};

// 6. The non-equality assertion tests for whether two objects are not equal
// with != assert.notEqual(actual, expected, message_opt);

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    fail(actual, expected, message, '!=', assert.notEqual);
  }
};

// 7. The equivalence assertion tests a deep equality relation.
// assert.deepEqual(actual, expected, message_opt);

assert.deepEqual = function deepEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected)) {
    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
  }
};

function _deepEqual(actual, expected) {
  // 7.1. All identical values are equivalent, as determined by ===.
  if (actual === expected) {
    return true;

  } else if (util.isBuffer(actual) && util.isBuffer(expected)) {
    if (actual.length != expected.length) return false;

    for (var i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) return false;
    }

    return true;

  // 7.2. If the expected value is a Date object, the actual value is
  // equivalent if it is also a Date object that refers to the same time.
  } else if (util.isDate(actual) && util.isDate(expected)) {
    return actual.getTime() === expected.getTime();

  // 7.3 If the expected value is a RegExp object, the actual value is
  // equivalent if it is also a RegExp object with the same source and
  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
    return actual.source === expected.source &&
           actual.global === expected.global &&
           actual.multiline === expected.multiline &&
           actual.lastIndex === expected.lastIndex &&
           actual.ignoreCase === expected.ignoreCase;

  // 7.4. Other pairs that do not both pass typeof value == 'object',
  // equivalence is determined by ==.
  } else if (!util.isObject(actual) && !util.isObject(expected)) {
    return actual == expected;

  // 7.5 For all other Object pairs, including Array objects, equivalence is
  // determined by having the same number of owned properties (as verified
  // with Object.prototype.hasOwnProperty.call), the same set of keys
  // (although not necessarily the same order), equivalent values for every
  // corresponding key, and an identical 'prototype' property. Note: this
  // accounts for both named and indexed properties on Arrays.
  } else {
    return objEquiv(actual, expected);
  }
}

function isArguments(object) {
  return Object.prototype.toString.call(object) == '[object Arguments]';
}

function objEquiv(a, b) {
  if (util.isNullOrUndefined(a) || util.isNullOrUndefined(b))
    return false;
  // an identical 'prototype' property.
  if (a.prototype !== b.prototype) return false;
  //~~~I've managed to break Object.keys through screwy arguments passing.
  //   Converting to array solves the problem.
  if (isArguments(a)) {
    if (!isArguments(b)) {
      return false;
    }
    a = pSlice.call(a);
    b = pSlice.call(b);
    return _deepEqual(a, b);
  }
  try {
    var ka = objectKeys(a),
        kb = objectKeys(b),
        key, i;
  } catch (e) {//happens when one is a string literal and the other isn't
    return false;
  }
  // having the same number of owned properties (keys incorporates
  // hasOwnProperty)
  if (ka.length != kb.length)
    return false;
  //the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  //~~~cheap key test
  for (i = ka.length - 1; i >= 0; i--) {
    if (ka[i] != kb[i])
      return false;
  }
  //equivalent values for every corresponding key, and
  //~~~possibly expensive deep test
  for (i = ka.length - 1; i >= 0; i--) {
    key = ka[i];
    if (!_deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// 8. The non-equivalence assertion tests for any deep inequality.
// assert.notDeepEqual(actual, expected, message_opt);

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (_deepEqual(actual, expected)) {
    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
  }
};

// 9. The strict equality assertion tests strict equality, as determined by ===.
// assert.strictEqual(actual, expected, message_opt);

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(actual, expected, message, '===', assert.strictEqual);
  }
};

// 10. The strict non-equality assertion tests for strict inequality, as
// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    fail(actual, expected, message, '!==', assert.notStrictEqual);
  }
};

function expectedException(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
    return expected.test(actual);
  } else if (actual instanceof expected) {
    return true;
  } else if (expected.call({}, actual) === true) {
    return true;
  }

  return false;
}

function _throws(shouldThrow, block, expected, message) {
  var actual;

  if (util.isString(expected)) {
    message = expected;
    expected = null;
  }

  try {
    block();
  } catch (e) {
    actual = e;
  }

  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
            (message ? ' ' + message : '.');

  if (shouldThrow && !actual) {
    fail(actual, expected, 'Missing expected exception' + message);
  }

  if (!shouldThrow && expectedException(actual, expected)) {
    fail(actual, expected, 'Got unwanted exception' + message);
  }

  if ((shouldThrow && actual && expected &&
      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
    throw actual;
  }
}

// 11. Expected to throw an error:
// assert.throws(block, Error_opt, message_opt);

assert.throws = function(block, /*optional*/error, /*optional*/message) {
  _throws.apply(this, [true].concat(pSlice.call(arguments)));
};

// EXTENSION! This is annoying to write outside this module.
assert.doesNotThrow = function(block, /*optional*/message) {
  _throws.apply(this, [false].concat(pSlice.call(arguments)));
};

assert.ifError = function(err) { if (err) {throw err;}};

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    if (hasOwn.call(obj, key)) keys.push(key);
  }
  return keys;
};

},{"util/":48}],44:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],45:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))
},{"_process":46}],46:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],47:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],48:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":47,"_process":46,"inherits":44}],49:[function(require,module,exports){
arguments[4][1][0].apply(exports,arguments)
},{"./lib":50,"c:\\Users\\kristian\\repos_public\\shadejs\\shadejs\\node_modules\\analyses\\index.js":1}],50:[function(require,module,exports){

module.exports = walker;

function walker(astNode, functionTable, offset) {
	function stop() { throw stop; }
	var recurse = function (astNode) {
		if (!astNode || typeof astNode !== 'object' || !astNode.type)
			return astNode;
		// range based recursion: only recurse when the astNode is in range
		if (offset !== undefined && astNode.range &&
		    (astNode.range[0] > offset || astNode.range[1] < offset))
			return astNode;
		
		var fn = functionTable[astNode.type] || functionTable.default || checkProps;
		return fn.call(astNode, recurse, stop);
	}
	var ret;
	try {
		ret = recurse(astNode);
	} catch (e) {
		if (e !== stop)
			throw e;
	}
	return ret;
}

function checkProps(recurse) {
	var self = this;
	var mapped = {};
	Object.keys(self).forEach(function (key) {
		var prop = self[key];
		var ret = prop;
		if (Array.isArray(prop))
			ret = prop.map(recurse);
		else
			ret = recurse(prop);
		mapped[key] = ret;
	});
	return mapped;
}

walker.checkProps = checkProps;

},{}],51:[function(require,module,exports){
(function(module){

    // Dependencies
    var Context = require("../base/context.js");
    var common = require("../base/common.js");
    var Base = require("../base/index.js");
    var Annotations = require("./../base/annotation.js");
    var assert = require('assert');
    var walk = require('estraverse');
    var InferenceScope = require("./typeinference/registry/").InferenceScope;
    var System = require("./typeinference/registry/system.js");
    var Shade = require("../interfaces.js");
        var codegen = require("escodegen");


    // Shortcuts
    var Map = common.Map,
        Syntax = common.Syntax,
        FunctionAnnotation = Annotations.FunctionAnnotation,
        ANNO = Annotations.ANNO;

    /**
     *
     * @param {*} program
     * @param {function} analysis
     * @param {*} options
     * @extends {Context}
     * @constructor
     */
    var AnalysisContext = function(program, analysis, options) {
        Context.call(this, program, options);

        assert.equal(program.type, Syntax.Program);

        /**
         * Callback that continues analysis in the same context
         * @see {AnalysisContext.analyze}
         * @type {Function}
         */
        this.analysis = analysis;

        this.root.globalParameters = {};


        var scope = createGlobalScope(program);
        registerSystemInformation(scope, options);
        this.pushScope(scope);

        /**
         * Map of (global) function name to untyped functions that
         * serve as a template for calls that might come with
         * different signatures
         * @type {Map}
         */
        this.functionMap = extractAllFunctions(program, this);


        /**
         * Cache of functions that types has already been derived.
         * Maps from signature to annotated ast
         * @type {Object}
         */
        this.derivedFunctions = {};

        this.constants = null;
    };

    Base.createClass(AnalysisContext, Context, {
        analyse: function() {
            return this.analysis.call(this, this.root, this.options);
        },
        getTypeInfo: function (node) {
            return common.getTypeInfo(node, this.getScope(), this.constants, true);
        },
        /**
         *
         * @param {null|Set}
         */
        setConstants: function(c) {
            this.constants = c;
        },
        callFunction: function (name, args, opt) {
            var signature = this.createSignatureFromNameAndArguments(name, args);
            var info = this.getFunctionInformationBySignature(signature);
            if (info)
                return info;

            return this.createFunctionInformationFor(name, args, opt);
        },
        createSignatureFromNameAndArguments: function (name, args) {
            return args.reduce(function (str, arg) {
                return str + arg.getTypeString()
            }, name);
        },
        getFunctionInformationBySignature: function (signature) {
            if (this.derivedFunctions.hasOwnProperty(signature)) {
                var derivedFunction = this.derivedFunctions[signature];
                //console.log("Reuse", signature);
                return derivedFunction.info;
            }
            return null;
        },
        createFunctionInformationFor: function (name, args, opt) {
            var ast, derived, globalName;
            opt = opt || {};

            if (this.functionMap.has(name)) {
                ast = this.functionMap.get(name);
                globalName = opt.name || this.getSafeUniqueName(name.replace(/\./g, '_'));
                derived = {};
                derived.ast = this.analyseFunction(JSON.parse(JSON.stringify(ast)), args);
                derived.info = derived.ast.extra.returnInfo;
                derived.info.newName = derived.ast.id.name = globalName;
                this.derivedFunctions[this.createSignatureFromNameAndArguments(name, args)] = derived;
                return derived.info;
            }
            throw new Error("Could not resolve function " + name);
        },
        analyseFunction: function(funcDecl, params) {
            var functionScope = new InferenceScope(funcDecl, this.getScope(), {name: funcDecl.id.name });
            var functionAnnotation = new FunctionAnnotation(funcDecl);

            //console.error("analyseFunction:", functionScope.str());

            setParameterTypes(funcDecl.params, params);
            functionScope.declareParameters(funcDecl.params);

            this.pushScope(functionScope);
            funcDecl.body = this.analysis.call(this, funcDecl.body, this.options);

            // Annotate Function Return type from Scope
            functionAnnotation.setReturnInfo(functionScope.getReturnInfo());
            this.popScope();
            return funcDecl;
        },
        getResult: function() {
            // (Re-)add derived function to the program
            addDerivedMethods(this.root, this);
            return this.root;
        },
        declareVariables: function (ast, inDeclaration) {
            var scope = this.getScope(), context = this;
            if (ast.type == Syntax.VariableDeclaration) {
                var declarations = ast.declarations;
                declarations.forEach(function (declaration) {
                    var result = ANNO(declaration);

                    if (declaration.id.type != Syntax.Identifier) {
                        throw new Error("Dynamic variable names are not yet supported");
                    }
                    var variableName = declaration.id.name;
                    scope.declareVariable(variableName, true, result);

                    if (declaration.init) {
                        var init = ANNO(declaration.init);
                        scope.updateTypeInfo(variableName, init, declaration);
                        if (declaration.init.type == Syntax.AssignmentExpression) {
                            context.declareVariables(declaration.init, true);
                        }
                    } else {
                        result.setType(Shade.TYPES.UNDEFINED);
                    }
                })
            } else if (ast.type == Syntax.AssignmentExpression && inDeclaration) {
                var typeInfo = ANNO(ast.right);

                if (ast.left.type != Syntax.Identifier) {
                    throw new Error("Dynamic variable names are not yet supported");
                }
                var variableName = ast.left.name;
                scope.declareVariable(variableName, true, ANNO(ast));
                scope.updateTypeInfo(variableName, typeInfo, ast);
                if (ast.right.type == Syntax.AssignmentExpression) {
                    context.declareVariables(ast.right, true);
                }
            }
            return true;
        },
        injectCall: function(name, entryParams) {

                if (!this.functionMap.has(name))
                    return;

                // First parameter is set as global _env object to be accessible form BRDFs
                // This is a big hack, need better injection mechanism
                var envObject = entryParams[0];
                if (envObject && envObject.extra) {
                    var envAnnotation = new Annotations.Annotation({}, envObject.extra);
                    this.getScope().updateTypeInfo("_env", envAnnotation);
                }

                this.root.globalParameters[name] = entryParams;
                this.callFunction(name, entryParams.map(function (param) {
                    return ANNO(param);
                }), { name: "shade"});

        }

    });


    /**
     *
     * @param prg
     * @param {AnalysisContext} context
     * @returns {Map}
     */
    function extractAllFunctions(prg, context) {
        var result = new Map();

        result.set("global", prg);

        walk.replace(prg, {
            enter: function (node) {
                if (node.type == Syntax.FunctionDeclaration) {
                    var localName = node.id.name;
                    var parentScope = context.getScope();
                    var anno = new FunctionAnnotation(node);
                    parentScope.declareVariable(localName);
                    parentScope.updateTypeInfo(localName, anno);

                    var newScope = new InferenceScope(node, parentScope, {name: localName });
                    result.set(newScope.str(), node);
                    context.pushScope(newScope);
                }
            },
            leave: function (node) {
                var replace;
                if (node.type == Syntax.FunctionDeclaration) {
                    context.popScope();
                    replace = { type: Syntax.EmptyStatement };
                }
                return replace;
            }
        });
        prg.body = prg.body.filter(function (a) {
            return a.type != Syntax.EmptyStatement;
        });
        return result;
    };


    function addDerivedMethods(program, context) {
        for(var func in context.derivedFunctions) {
            program.body.push(context.derivedFunctions[func].ast);
        }

        walk.traverse(program, {
            enter: function(node) {
                if(node.type == Syntax.CallExpression) {
                    if(node.extra && node.extra.newName) {
                        node.callee.name = node.extra.newName;
                    };
                }
            }
        });
    }

    /**
     *
     * @param {Array.<Object>} params
     * @param {Array.<Object>} types
     */
    function setParameterTypes(params, types) {
        for (var i = 0; i < params.length; i++) {
            var funcParam = ANNO(params[i]);
            if (i < types.length) {
                funcParam.setFromExtra(types[i].getExtra());
                funcParam.setDynamicValue();
            } else {
                funcParam.setType(Shade.TYPES.UNDEFINED);
            }
        }
    }

    function createGlobalScope(ast) {
        var globalScope = new InferenceScope(ast, null, {name: "global"});
        globalScope.registerGlobals();
        return globalScope;
    };

    function registerSystemInformation(scope, opt) {
        var thisInfo = (opt.inject && opt.inject.this) || null;
        scope.declareVariable("this");
        scope.updateTypeInfo("this", System.getThisTypeInfo(thisInfo));
    }

    module.exports = AnalysisContext;


}(module));

},{"../base/common.js":82,"../base/context.js":83,"../base/index.js":85,"../interfaces.js":111,"./../base/annotation.js":80,"./typeinference/registry/":62,"./typeinference/registry/system.js":68,"assert":43,"escodegen":9,"estraverse":42}],52:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var sanitizer = require("./sanitizer/sanitizer.js"),
        resolver =  require("../resolve/resolve.js"),
        staticTransformer = require("./constants/staticTransformer.js"),
        uniformAnalysis = require("./uniformExpressions/uniformAnalysis.js"),
        validator = require("./validator.js"),
        semantics = require("./semantics/semantics.js"),
        AnalysisContext = require("./analysiscontext.js"),
        inference = require("./typeinference/typeinference.js"),
        spaceTransformer = require("../generate/space/transform.js").SpaceTransformer,
        Annotations = require("./../base/annotation.js"),
        codegen = require("escodegen");


    // Shortcuts
    var ANNO = Annotations.ANNO;

    /**
     * This is the main analysis
     * @param {Object} ast
     * @param {Object|null} opt
     * @returns {Object}
     */
    var analyze = function (ast, processingData, opt) {
        opt = opt || {};
        processingData = processingData || {};

        var error;

        try {
            // Resolve BRDF closures
            ast = opt.implementation ? resolver.resolveClosuresPreTypeInference(ast, opt.implementation, processingData, opt) : ast;

            // Sanitize strange expressions into something
            // that is better analysable
            ast = opt.sanitize ? sanitizer.sanitize(ast, opt) : ast;

            //console.log("Analyze", codegen.generate(ast), ast.type, opt.sanitize);
            var context = new AnalysisContext(ast, function(ast, options) {
                    // Calculate types and static values
                    ast = inference.infer(ast, this, options);

                    // Remove/Replace dead code and static expressions
                    ast = staticTransformer.transform(ast, options);

                    ast = opt.extractUniformExpressions ? uniformAnalysis.extract(ast, opt) : ast;
                    //console.log(opt.uniformExpressions);

                    ast = opt.semanticAnalysis ?  semantics(ast, opt) : ast;

                    return ast;

            }, opt);

            context.analyse();
            if (opt.entry) {
                context.injectCall(opt.entry, (opt.inject &&  opt.inject[opt.entry]) || []);
            }
            ast = context.getResult();

            ast = opt.implementation ? resolver.resolveClosuresPostTypeInference(ast, opt.implementation, processingData, opt) : ast;

            // check for remaining code the completeness of annotations
            ast = opt.validate ? validator.validate(ast) : ast;

            if(opt.transformSpaces)
                processingData.spaceInfo = spaceTransformer.transformAast(ast, opt);

        } catch (e) {
            if(opt.throwOnError) {
                throw e;
            }
            error = e;
        }

        return {
            ast: ast,
            error: error
        };

    };

    ns.analyze = analyze;

}(exports));

},{"../generate/space/transform.js":108,"../resolve/resolve.js":114,"./../base/annotation.js":80,"./analysiscontext.js":51,"./constants/staticTransformer.js":54,"./sanitizer/sanitizer.js":56,"./semantics/semantics.js":57,"./typeinference/typeinference.js":74,"./uniformExpressions/uniformAnalysis.js":76,"./validator.js":79,"escodegen":9}],53:[function(require,module,exports){
(function(ns){

    var Syntax = require('estraverse').Syntax,
        ANNO = require("../../base/annotation.js").ANNO,
        Shade = require("../../interfaces.js");


    var UnaryFunctions = {
        "!": function(a) { return !a; },
        "-": function(a) { return -a; },
        "+": function(a) { return +a; },
        "typeof": function(a) { return typeof a; },
        "void": function(a) { return void a; },
        "delete": function(a) { return true; }

    };

    var BinaryFunctions = {
        "+" : function(a,b) { return a + b; },
        "-" : function(a,b) { return a - b; },
        "/" : function(a,b) { return a / b; },
        "*" : function(a,b) { return a * b; },
        "%" : function(a,b) { return a % b; },

        "==" : function(a,b) { return a == b; },
        "!=" : function(a,b) { return a != b; },
        "===" : function(a,b) { return a === b; },
        "!==" : function(a,b) { return a !== b; },
        "<" : function(a,b) { return a < b; },
        "<=" : function(a,b) { return a <= b; },
        ">" : function(a,b) { return a > b; },
        ">=" : function(a,b) { return a >= b; }
    };


    /**
     *
     * @param node
     */
    function getStaticValue(node) {
        if (node.type === Syntax.Literal) {
            var value = node.raw !== undefined ? node.raw : node.value;
            var number = parseFloat(value);
            if (!isNaN(number))
                return number;
            value = node.value;
            switch(value) {
                case "true": return true;
                case "false": return false;
                case "null": return null;
                default: return value;
            }
        }
        if (node.type == Syntax.MemberExpression || node.type == Syntax.CallExpression  || node.type == Syntax.Identifier || node.type == Syntax.NewExpression || node.type == Syntax.LogicalExpression) {
            return ANNO(node).getStaticValue();
        }
        if (node.type === Syntax.UnaryExpression) {
            if (node.operator == "typeof") {
                return ANNO(node).getStaticValue();
            }
            if(UnaryFunctions.hasOwnProperty(node.operator)) {
                return UnaryFunctions[node.operator](getStaticValue(node.argument));
            }
            Shade.throwError(node, "Unknown unary operator: " + node.operator);
        }
        if (node.type === Syntax.BinaryExpression) {
            if(BinaryFunctions.hasOwnProperty(node.operator)) {
                return BinaryFunctions[node.operator](getStaticValue(node.left), getStaticValue(node.right));
            }
            Shade.throwError(node, "Unknown binary operator: " + node.operator);
        }
        Shade.throwError(node, "Evaluating static value for node type: " + node.type);
    };


    function getStaticTruthValue(node) {
        var aNode = ANNO(node);

        // !!undefined == false;
        if (aNode.isNullOrUndefined())
            return false;
        // !!{} == true
        if (aNode.isObject() || this.isFunction())
            return true;
        // In all other cases, it depends on the value,
        // thus we can only evaluate this for static objects
        if (aNode.hasStaticValue()) {
            return !!aNode.getStaticValue();
        }
        return undefined;
    }

    exports.getStaticValue = getStaticValue;
    exports.getStaticTruthValue = getStaticTruthValue;



}(exports));

},{"../../base/annotation.js":80,"../../interfaces.js":111,"estraverse":42}],54:[function(require,module,exports){
(function (ns) {

    var common = require("../../base/common.js"),
        Shade = require("../../interfaces.js"),
        Base = require("../../base/index.js"),
        estraverse = require('estraverse');

    // var codegen = require('escodegen');

    var Syntax = common.Syntax,
        TYPES = Shade.TYPES,
        ANNO = common.ANNO;


    /**
     * Transform AST: Eliminate branches due to static conditions
     * and performs constant folding
     * @param {Object} ast
     * @returns Object
     */
    var transform = ns.transform = function (ast, opt) {
        var transformer = new Transformer(opt);
        return transformer.transform(ast);
    }

    var Transformer = function(opt) {
        opt = opt || {};

        this.foldConstants = opt.foldConstants !== undefined ? opt.foldConstants : true;

        this.controller = new estraverse.Controller();
    };

    Transformer.prototype = {
        transform: function (ast) {
            var that = this;
            return this.controller.replace(ast, {
                enter: function (node, parent) {
                    var typeInfo = ANNO(node);
                    if (!typeInfo.isValid()) {
                        return;
                    }

                    switch (node.type) {
                        case Syntax.IfStatement:
                            return that.handleIfStatement(node);
                        case Syntax.ConditionalExpression:
                            return that.handleConditionalExpression(node);
                        case Syntax.LogicalExpression:
                            return that.handleLogicalExpression(node);
                        case Syntax.AssignmentExpression:
                            return that.handleAssignmentExpression(node);
                        case Syntax.VariableDeclarator:
                            return that.handleVariableDeclarator(node);
                        case Syntax.NewExpression:
                            //case Syntax.CallExpression:
                            return that.handleNewExpression(node);
                        case Syntax.VariableDeclaration:
                            return that.handleVariableDeclaration(node);

                    }

                    if(that.foldConstants && isExpression(node.type, parent.type)) {
                        return that.foldConstantExpression(node);
                    }
                }
            });
        },


        handleIfStatement: function (node) {
            var test = ANNO(node.test);

            if (test.hasStaticValue() || test.canObject()) {
                this.controller.skip();
                var staticValue = test.getStaticTruthValue();
                if (staticValue === true) {
                    return transform(node.consequent);
                }
                if (staticValue === false) {
                    if (node.alternate) {
                        return this.transform(node.alternate);
                    }
                    return {
                        type: Syntax.EmptyStatement
                    }
                }
            }
        },


        handleConditionalExpression: function (node) {
            var test = ANNO(node.test);

            if (test.hasStaticValue() || test.canObject()) {
                this.controller.skip();
                var staticValue = test.getStaticTruthValue();
                if (staticValue === true) {
                    return this.transform(node.consequent);
                } else {
                    return this.transform(node.alternate);
                }
            }
        },

        handleLogicalExpression: function (node) {
            var left = ANNO(node.left);
            var right = ANNO(node.right);
            var leftBool = left.getStaticTruthValue();
            var rightBool = right.getStaticTruthValue();

            if (node.operator === "||") {
                if (leftBool === false) {
                    return node.right;
                }
                if (leftBool === true) {
                    return node.left;
                }
                // Left is dynamic, let's check right
                if (rightBool === false) {
                    return node.left;
                }
            } else if (node.operator === "&&") {
                if (leftBool === false) {
                    return node.left;
                }
                if (leftBool === true) {
                    return node.right;
                }
                // Left is dynamic, let's check right
                if (rightBool === true) {
                    // Now the result type is always the one of the left value
                    return node.left;
                }
                if (rightBool === false) {
                    // Now the result must be false
                    return {
                        type: Syntax.Literal,
                        value: "false",
                        extra: { type: "boolean"}
                    };
                }
            }
        },

        handleAssignmentExpression: function (node) {
            node.right = this.foldConstantExpression(node.right);
            return node;
        },
        handleNewExpression: function (node) {
            var args = node.arguments, newArgs = [];
            args.forEach(function (arg) {
                var typeInfo = ANNO(arg);
                if (isSimpleStatic(typeInfo)) {
                    newArgs.push(generateLiteralFromTypeInfo(typeInfo))
                } else {
                    newArgs.push(arg);
                }
            });
            node.arguments = newArgs;
            return node;
        },

        handleVariableDeclaration: function (node) {
            var declarations = node.declarations, newDeclarations = [], that = this;
            declarations.forEach(function (declaration) {
                var typeInfo = ANNO(declaration);
                if (!typeInfo.isUndefined()) {
                    newDeclarations.push(declaration);
                }
            });
            node.declarations = newDeclarations;
            return node;
        },
        handleVariableDeclarator: function (node) {
            if (node.init) {
                node.init = this.foldConstantExpression(node.init);
                return node;
            }
        },
        foldConstantExpression: function (node) {
            var anno = ANNO(node);
            if (this.foldConstants) {
                if (isSimpleStatic(anno)) {
                    return generateLiteralFromTypeInfo(anno);
                } else if (isStaticObject(anno)) {
                    return generateConstructorFromTypeInfo(anno);
                }
            }
            return node;
        }


    };

    function isSimpleStatic(typeInfo) {
        return typeInfo.hasStaticValue() && !(typeInfo.isObject() || typeInfo.isNullOrUndefined());
    }

     function isStaticObject(typeInfo) {
        return typeInfo.hasStaticValue() && typeInfo.isVector();
    }

    var c_expressions = [Syntax.BinaryExpression, Syntax.UnaryExpression, Syntax.MemberExpression];
    var c_parentLiteralExpressions = [Syntax.BinaryExpression, Syntax.ReturnStatement, Syntax.CallExpression];


    function isExpression(type, parentType) {
        if(type === Syntax.Identifier) {
            return c_parentLiteralExpressions.indexOf(parentType) !== -1;
        }
        return c_expressions.indexOf(type) !== -1;
    };


    function generateConstructorFromTypeInfo(typeInfo) {
        var value = typeInfo.getStaticValue(), size, name, arguments = [];
        switch(typeInfo.getKind()) {
            case Shade.OBJECT_KINDS.FLOAT2: size = 2; name = "Vec2"; break;
            case Shade.OBJECT_KINDS.FLOAT3: size = 3; name = "Vec3"; break;
            case Shade.OBJECT_KINDS.FLOAT4: size = 4; name = "Vec4"; break;
            default:
                throw new Error("Internal error in static transformation. Unknown kind: " + typeInfo.getKind());
        }

        var same = true;
        for(var i = 0; (i < size-1) && same; ++i) {
            same = same && value[i] == value[i+1];
        }

        size = same ? 1 : size;

        for(i = 0; i < size; ++i) {
            arguments.push(generateFloatLiteralFromValue(value[i]));
        }


        var result = {
            type: Syntax.NewExpression,
            callee: {
                type: Syntax.Identifier,
                name: name
            },
            arguments: arguments
        }
        ANNO(result).copy(typeInfo);
        return result;
    }

    function generateFloatLiteralFromValue(value) {
        var needsSign = value < 0;

        var literal = { type: Syntax.Literal, value: needsSign ? -value : value };
        ANNO(literal).setType(Shade.TYPES.NUMBER);

        if (!needsSign)
            return literal;

        var expression = {
                type: Syntax.UnaryExpression,
                operator: "-",
                argument: literal
        }
        ANNO(expression).setType(Shade.TYPES.NUMBER);
        return expression;
    }

    function generateLiteralFromTypeInfo(typeInfo) {
        var value = typeInfo.getStaticValue();
        var isNegative = value < 0;

        var result = {
            type: Syntax.Literal,
            value: isNegative ? -value : value,
            extra: {}
        }
        Base.extend(result.extra, typeInfo.getExtra());

        if(isNegative) {
            result.extra.staticValue = -value;
            result = {
                type: Syntax.UnaryExpression,
                operator: "-",
                argument: result,
                extra: {}
            }
            Base.extend(result.extra, typeInfo.getExtra());
        }
        return result;
    }









}(exports));

},{"../../base/common.js":82,"../../base/index.js":85,"../../interfaces.js":111,"estraverse":42}],55:[function(require,module,exports){
(function (ns) {

    var walk = require('estraverse'),
        Scope = require("./../base/scope.js"),
        resolver = require("../resolve/resolve.js"),
        Syntax = walk.Syntax;

    var derivedSystemParameters = {
        normalizedCoords: ["coords"],
        height: ["coords"],
        width: ["coords"]
    };


    /**
     *
     * @param {{shaderParameters: Array, systemParameters: Array}} result
     * @param {{shaderParameters: Array, systemParameters: Array}} other
     */
    function merge(result, other) {
        var i, param;
        for (var container in result) {
            for(i = 0; i < other[container].length; i++) {
                param = other[container][i];
                if (result[container].indexOf(param) == -1) {
                    result[container].push(param);
                }
            }
        }
    }

    function addSystemParameter(parameterName, container, parameterMap) {
        // Is parameter already in container?
        if (container.indexOf(parameterName) != -1)
            return;

        if (parameterMap && parameterMap.hasOwnProperty(parameterName)) {
            var requiredParameters = parameterMap[parameterName];
            requiredParameters.forEach(function (param) {
                addSystemParameter(param, container, parameterMap);
            });
            return;
        }
        container.push(parameterName);
    }

    /**
     * @param {string} functionName Global name of the function to analyze
     * @param {*} program AST of the program
     * @param {number} environmentObjectPosition
     * @param {object=} analyzedCalls
     * @returns {{shaderParameters: Array, systemParameters: Array}}
     */
    var findParametersInFunction = function (functionName, program, environmentObjectPosition, analyzedCalls) {
        var context = new Scope(program, null, {name: "global"});
        var contextStack = [context];

        var result = { shaderParameters: [], systemParameters: [] };
        analyzedCalls = analyzedCalls || {};
        // console.log("Looking for: ", functionName, environmentObjectPosition);

        var activeParam = null;

        var controller = new walk.Controller();
        controller.traverse(program, {
            enter: function (node) {
                var type = node.type,
                    context, retVal = null;
                switch (type) {
                    case Syntax.FunctionDeclaration:
                        var parentContext = contextStack[contextStack.length - 1];
                        parentContext.declareVariable(node.id.name, false);
                        context = new Scope(node, parentContext, {name: node.id.name });
                        contextStack.push(context);
                        if (context.str() == functionName) {
                            if (environmentObjectPosition != -1 && node.params.length > environmentObjectPosition) {
                                activeParam = node.params[environmentObjectPosition].name;
                            }
                        } else {
                            controller.skip();
                        }
                        break;
                    case Syntax.CallExpression:
                        var pos = node.arguments.reduce(function (prev, curr, index) {
                            if (curr.name && curr.name == activeParam)
                                return index;
                            return prev;
                        }, -1);
                        context = contextStack[contextStack.length - 1];
                        var id = context.getVariableIdentifier(node.callee.name);
                        if (id && !analyzedCalls[id]) {
                            analyzedCalls[id] = true;
                            merge(result, findParametersInFunction(id, program, pos, analyzedCalls));
                        }
                        break;
                    default:
                }
            },
            leave: function (node) {
                var type = node.type;
                switch (type) {
                    case Syntax.FunctionDeclaration:
                        contextStack.pop();
                        activeParam = null;
                        break;
                    case Syntax.MemberExpression:
                        var parameterName = node.property.name;
                        // In a specific parameter of the current method
                        if (activeParam && node.object.name == activeParam) {
                            addSystemParameter(parameterName, result.shaderParameters);
                        } // In 'this' is a system parameter
                        else if (node.object.type == Syntax.ThisExpression) {
                            addSystemParameter(parameterName, result.systemParameters, derivedSystemParameters);
                        } // In global variable '_env'
                        else if (node.object.name == "_env") {
                            addSystemParameter(parameterName, result.shaderParameters);
                        }
                        break;
                }
            }
        });

        return result;
    };

    /**
     * @param {object!} program
     * @param {object?} opt
     * @returns {{shaderParameters: Array, systemParameters: Array}}
     */
    ns.extractParameters = function (program, opt) {
        opt = opt || {};
        var functionName = opt.context || "global.shade";
        var parameterPosition = opt.param || 0;

        if(opt.implementation) {
            program = resolver.resolveClosuresPreTypeInference(program, opt.implementation, opt);
        }
        return findParametersInFunction(functionName, program, parameterPosition);
    };


}(exports));

},{"../resolve/resolve.js":114,"./../base/scope.js":86,"estraverse":42}],56:[function(require,module,exports){
(function (ns) {
    /**
     * Shade.js specific type inference that is also inferring
     * virtual types {@link Shade.TYPES }
     */

    var walk = require('estraverse'),
        assert = require("assert"),
        Base = require("../../base/index.js"),
        common = require("./../../base/common.js"),
        Shade = require("../../interfaces.js");

    var Syntax = walk.Syntax;
    var VisitorOption = walk.VisitorOption;


    var DeclarationSimplifier = function (opt) {
        this.declarationStack = [];
    };
    Base.extend(DeclarationSimplifier.prototype, {

        execute: function (root) {
            walk.replace(root, {
                enter: this.enterNode.bind(this),
                leave: this.exitNode.bind(this)
            });
            return root;
        },

        enterNode: function (node, parent) {
            switch(node.type){
                case Syntax.FunctionExpression:
                case Syntax.FunctionDeclaration:
                case Syntax.Program:
                    this.declarationStack.push([]);
                    break;
                case Syntax.VariableDeclarator:
                    this.addDeclaredIdentifier(node.id.name);
                    break;
            }
        },

        exitNode: function (node, parent) {
            switch(node.type){
                case Syntax.FunctionExpression:
                case Syntax.FunctionDeclaration:
                case Syntax.Program:
                    return this.addTopDeclaration(node, parent);
                    break;
                case Syntax.VariableDeclaration:
                    return this.removeMidCodeDeclaration(node, parent);
            }
        },

        removeMidCodeDeclaration: function(node, parent){
            var newNode;
            var isForInit = (parent.type == Syntax.ForStatement && parent.init == node);
            if(isForInit){
                newNode = {
                    type: Syntax.SequenceExpression,
                    expressions: [],
                    loc: node.loc
                }
            }
            else{
                newNode = {
                    type: Syntax.BlockStatement,
                    body: [],
                    loc: node.loc
                }
            }

            var declarations = node.declarations;
            for(var i = 0; i < declarations.length; ++i){
                var declaration = declarations[i];
                if(declaration.init){
                    var expression = {
                        type: Syntax.AssignmentExpression,
                        operator: "=",
                        left: declaration.id,
                        right: declaration.init,
                        loc: declaration.loc
                    };
                    if(isForInit)
                        newNode.expressions.push(expression);
                    else{
                        var statement = {
                            type: Syntax.ExpressionStatement,
                            expression: expression,
                            loc: declaration.loc
                        }
                        newNode.body.push(statement);
                    }
                }
            }
            if(isForInit && newNode.expressions.length == 1){
                return newNode.expressions[0];
            }
            return newNode;
        },

        addTopDeclaration: function(node, parent){
            var declarations = this.declarationStack.pop();
            if(declarations.length > 0){
                var declarationStatement = {
                    type: Syntax.VariableDeclaration,
                    declarations: [],
                    kind: "var"
                };
                for(var i = 0; i < declarations.length; ++i){
                    declarationStatement.declarations[i] = {
                        type: Syntax.VariableDeclarator,
                        id: { type: Syntax.Identifier, name: declarations[i] },
                        init: null
                    }
                }
                if(node.type == Syntax.Program)
                    node.body.unshift(declarationStatement);
                else if(node.body.body)
                    node.body.body.unshift(declarationStatement);
            }
            return node;
        },

        addDeclaredIdentifier: function(name){
            var topStack = this.declarationStack[this.declarationStack.length - 1];
            if(topStack.indexOf(name) == -1)
                topStack.push(name);
        }


    });

    var StatementSimplifier = function (opt) {
        opt = opt || {};

        /**
         * The root of the program AST
         * @type {*}
         */
        this.statementIdentifierInfo = {};
        this.scopes = [];
        this.preContinueStatements = [];
    };

    Base.extend(StatementSimplifier.prototype, {

        execute: function (root) {
            walk.replace(root, {
                enter: this.enterNode.bind(this),
                leave: this.exitNode.bind(this)
            });
            return root;
        },


        gatherStatmentSplitInfo: function(node){
            this.statementIdentifierInfo = {};
            this.currentStatementTmpUsed = [];
            this.assignmentsToBePrepended = [];
            return walk.replace(node, {
                enter: this.statementSplitEnter.bind(this),
                leave: this.statementSplitExit.bind(this)
            });
        },

        isRedundant: function(node){
            var result = true;
            walk.traverse(node, {
                enter: function(node){
                    switch(node.type){
                        case Syntax.AssignmentExpression:
                        case Syntax.UpdateExpression:
                        case Syntax.FunctionExpression:
                        case Syntax.FunctionDeclaration:
                        case Syntax.CallExpression:
                            result = false;
                            this.break();
                    }
                }
            });
            return result;
        },

        pushScope: function(){
            var newScope = {
                declared: [],
                tmpDeclared: []
            };
            this.scopes.push(newScope);
            return newScope;
        },
        popScope: function(){
            return this.scopes.pop();
        },
        getScope: function(){
            return this.scopes[this.scopes.length - 1];
        },
        addPreContinueStatements: function(statements){
            var last = this.preContinueStatements[this.preContinueStatements.length - 1];
            last.push.apply(last, statements);
        },
        getPreContinueStatements: function(){
            return this.preContinueStatements[this.preContinueStatements.length - 1];
        },

        enterNode: function (node, parent) {
            switch(node.type){
                case Syntax.FunctionExpression:
                case Syntax.FunctionDeclaration:
                case Syntax.Program:
                    var newScope= this.pushScope();
                    if(node.params){
                        for(var i = 0; i < node.params.length; ++i){
                            newScope.declared.push(node.params[i].name);
                        }
                    }
                    break;
                case Syntax.VariableDeclarator:
                    this.addDeclaredIdentifier(node.id.name);
                    break;
                case Syntax.ContinueStatement:
                    return this.extendContinueStatement(node);
                case Syntax.ExpressionStatement:
                    return this.performStatementSplit(node, [{pre: true}]);
                case Syntax.IfStatement:
                    return this.performStatementSplit(node, [{prop: "test", pre: true}]);
                case Syntax.WhileStatement:
                    return this.performStatementSplit(node, [{prop: "test", pre: true, post: true}], "body");
                case Syntax.ForStatement:
                    return this.performStatementSplit(node, [ /*{prop: "init", pre: true, extract: true},
                                                             {prop: "update", post: true, extract: true},*/
                                                             {prop: "test", pre: true, post: true}], "body");
                case Syntax.DoWhileStatement:
                    return this.performStatementSplit(node, [{prop: "test", post: true}], "body");
            }
        },

        exitNode: function (node, parent) {
            switch(node.type){
                case Syntax.FunctionExpression:
                case Syntax.FunctionDeclaration:
                    return this.addTmpDeclaration(node);
                case Syntax.Program:
                    this.removeRedundantBlocks(node, "body");
                    return this.addTmpDeclaration(node);
                case Syntax.BlockStatement:
                    return this.removeRedundantBlocks(node, "body");
                case Syntax.SwitchCase:
                    return this.removeRedundantBlocks(node, "consequent");
                case Syntax.ContinueStatement:
                    delete node._extended;
                    break;
                case Syntax.WhileStatement:
                case Syntax.ForStatement:
                case Syntax.DoWhileStatement:
                    if(node._preContinueStacked){
                        delete node._preContinueStacked;
                        this.preContinueStatements.pop();
                    }
                    break;
            }
        },


        statementSplitEnter: function(node, parent){
            switch(node.type){
                case Syntax.FunctionExpression:
                    return VisitorOption.Skip;
                case Syntax.Identifier:
                    return this.identifierEnter(node, parent);
                case Syntax.AssignmentExpression:
                case Syntax.UpdateExpression:
                    return this.assignmentEnter(node, parent);
            }
        },

        statementSplitExit: function (node, parent) {
            switch(node.type){
                case Syntax.AssignmentExpression:
                case Syntax.UpdateExpression:
                    return this.assignmentExit(node, parent);
                    break;
            }
        },


        addDeclaredIdentifier: function(name){
            var declared = this.getScope().declared;
            if(declared.indexOf(name) == -1)
                declared.push(name);
        },

        isNameDeclared: function(name){
            var i = this.scopes.length;
            while(i--){
                if(this.scopes[i].declared.indexOf(name) != -1)
                    return true;
            }
            if(this.getScope().tmpDeclared.indexOf(name) != -1)
                return true;
            return false;
        },

        getFreeName: function(){
            var resultIdx = 0;
            var result;
            do{
                result = "_tmp" + resultIdx++;
            }while(this.isNameDeclared(result) || this.currentStatementTmpUsed.indexOf(result) != -1);
            this.currentStatementTmpUsed.push(result);
            var scope = this.getScope();
            if(scope.tmpDeclared.indexOf(result) == -1)
                scope.tmpDeclared.push(result);
            return result;
        },

        identifierEnter: function(node, parent){
            if(parent.type == Syntax.MemberExpression)
                return;
            if(parent.type == Syntax.AssignmentExpression && parent.left == node)
                return;
            var name = node.name;
            if(!this.statementIdentifierInfo[name])
                this.statementIdentifierInfo[name] = { reads: [], lastWrite: null };
            this.statementIdentifierInfo[name].reads.push(node);
        },

        assignmentEnter: function(node, parent){
            if(parent.type == Syntax.ExpressionStatement)
                return;
            if((node.left || node.argument).type != Syntax.Identifier)
                throw Shade.throwError(node, "We only support nested assignments for simple identifiers, not objects or arrays.");

            if(node.type == Syntax.UpdateExpression){
                var usePrevValue = !node.prefix;
                node = { type: Syntax.AssignmentExpression,
                        operator: "=",
                        left: {type: Syntax.Identifier, name: node.argument.name, loc: node.argument.loc},
                        right: { type: Syntax.BinaryExpression,
                                 operator: node.operator == "++" ? "+" : "-",
                                 left:  {type: Syntax.Identifier, name: node.argument.name , loc: node.argument.loc},
                                 right: {type: Syntax.Literal, value: 1}
                        },
                        loc: node.loc,
                        _usePrevValue: usePrevValue
                };

            }
            else if(node.type == Syntax.AssignmentExpression && node.operator != "="){
                var binaryOperator = node.operator.substr(0, node.operator.length-1);
                node.operator = "=";
                node.right = { type: Syntax.BinaryExpression,
                               operator: binaryOperator,
                               left: {type: Syntax.Identifier, name: node.left.name, loc: node.right.loc },
                               right: node.right,
                               loc: node.right.loc};
            }
            var name = node.left.name;
            var entry = this.statementIdentifierInfo[name];
            if(entry && entry.reads.length > 0)
                node._preIdentifierWriter = entry.lastWrite;
            return node;
        },

        assignmentExit: function(node, parent){
            if(parent.type == Syntax.ExpressionStatement)
                return;

            var readOldValue = node._usePrevValue;
            delete node._usePrevValue;

            var oldName = node.left.name;
            if(!this.statementIdentifierInfo[oldName]){
                this.statementIdentifierInfo[oldName] = { reads: [], lastWrite: null };
            }

            var entry = this.statementIdentifierInfo[oldName];

            var readReplace = {
                type: Syntax.Identifier,
                name: oldName,
                loc: node.loc
            };
            if(readOldValue || (node._preIdentifierWriter !== undefined && node._preIdentifierWriter == entry.lastWrite)){
                var newName = this.getFreeName();
                if(!entry.lastWrite){
                    var copyAssignment = {
                        type: Syntax.AssignmentExpression,
                        left: { type: Syntax.Identifier, name: newName },
                        right: {type: Syntax.Identifier, name: oldName},
                        operator: "="
                    };
                    this.assignmentsToBePrepended.unshift(copyAssignment);
                }else{
                    entry.lastWrite.left.name = newName;
                }
                for(var i = 0; i < entry.reads.length; ++i){
                    entry.reads[i].name = newName;
                }
            }
            entry.reads = [];
            delete node._preIdentifierWriter;
            entry.lastWrite = node;

            if(readOldValue)
                readReplace.name = newName;
            else
                this.statementIdentifierInfo[oldName].reads.push(readReplace);


            this.assignmentsToBePrepended.push(node);
            return readReplace;
        },

        performStatementSplit: function(node, subProperties, bodyProperty){
            if(bodyProperty && !node._preContinueStacked){
                this.preContinueStatements.push([]);
                node._preContinueStacked = true;
            }

            var originalNode = node, returnNode = node;
            for(var i = 0; i < subProperties.length; ++i){
                var property = subProperties[i].prop;
                var target = originalNode;
                if(property) target = originalNode[property];
                if(property && subProperties[i].extract){
                    this.statementIdentifierInfo = {};
                    this.currentStatementTmpUsed = [];
                    this.assignmentsToBePrepended = target ? [target] : [];
                    originalNode[property] = null;
                }
                else{
                    target = this.gatherStatmentSplitInfo(target);
                    if(property)
                        originalNode[property] = target;
                    else
                        returnNode = target;
                }
                if(this.assignmentsToBePrepended.length > 0){
                    if(subProperties[i].pre){
                        returnNode = this.getSplittedStatementBlock(this.assignmentsToBePrepended, returnNode);
                    }
                    if(subProperties[i].post){
                        var body = originalNode[bodyProperty];
                        var statements = this.getSplittedStatementBlock(this.assignmentsToBePrepended);
                        if(body && body.type == Syntax.BlockStatement){

                            body.body.push(statements);
                        }
                        else{
                            if(body) statements.body.unshift(body);
                            originalNode[bodyProperty] = statements;
                        }
                        this.addPreContinueStatements(this.assignmentsToBePrepended);
                    }
                }
            }
            return returnNode;
        },

        extendContinueStatement: function(node){
            if(node._extended)
                return;
            node._extended = true;
            var statements = this.getPreContinueStatements();
            if(statements.length == 0 )
                return node;
            return this.getSplittedStatementBlock(statements,node);
        },

        getSplittedStatementBlock: function(statements, node){
            var result = {
                type: Syntax.BlockStatement,
                body: [],
                loc: node && node.loc
            };
            for(var i = 0; i < statements.length; ++i){
                var assignment = Base.deepExtend({}, statements[i]);
                result.body.push({
                   type: Syntax.ExpressionStatement,
                   expression: assignment,
                   loc: assignment.loc
                });
            }
            if(node && (node.type != Syntax.ExpressionStatement || !this.isRedundant(node))){
                result.body.push(node);
            }
            return result;
        },



        removeRedundantBlocks: function(node, propertyName){
            var list = node[propertyName];
            var i = list.length;
            while(i--){
                if(list[i].type == Syntax.BlockStatement){
                    var args = [i, 1];
                    args.push.apply(args, list[i].body);
                    list.splice.apply(list, args);
                }
            }
            return node;
        },

        addTmpDeclaration: function(node){
            var tmpDeclared = this.getScope().tmpDeclared;
            if(tmpDeclared.length == 0)
                return;
            var list;
            if(node.type == Syntax.Program)
                list = node.body;
            else
                list = node.body.body;
            var declaration = null;
            if(list[0].type == Syntax.VariableDeclaration)
                declaration = list[0];
            else{
                declaration = {
                    type: Syntax.VariableDeclaration,
                    declarations: [],
                    kind: "var"
                };
                list.unshift(declaration);
            }
            for(var i = 0; i < tmpDeclared.length; ++i)
                declaration.declarations.push ({
                    type : Syntax.VariableDeclarator,
                    id: { type: Syntax.Identifier, name: tmpDeclared[i] },
                    init: null
                });

            this.popScope();
        }
    });


    ns.sanitize = function (ast, opt) {
        var declarationSimplifier = new DeclarationSimplifier(opt);
        var statementSimplifier = new StatementSimplifier(opt);
        ast = declarationSimplifier.execute(ast);
        ast = statementSimplifier.execute(ast);
        return ast;
    };


}(exports));

},{"../../base/index.js":85,"../../interfaces.js":111,"./../../base/common.js":82,"assert":43,"estraverse":42}],57:[function(require,module,exports){
(function (module) {

    // dependencies
    var walker = require('walkes');
    var worklist = require('analyses');
    var common = require("../../base/common.js");
    var codegen = require('escodegen');
    var Tools = require("./../settools.js");
    var esgraph = require('esgraph');


    // shortcuts
    var Syntax = common.Syntax;
    var Set = worklist.Set;
    var ANNO = common.ANNO;

    // defines

    /**
     * Possible semantics
     * @enum
     * @type {{COLOR: string, NORMAL: string, UNKNOWN: string}}
     */
    var Semantic = {
        COLOR: 'color',
        NORMAL: 'normal',
        UNKNOWN: 'unknown'
    };


    /**
     * @param cfg
     * @param {FlowNode} start
     * @returns {Map}
     */
    function compute(body, start) {

        var cfg = esgraph(body, { omitExceptions: true });

        var result = worklist(cfg, transferFunction, {
            direction: 'backward',
            start: new Set(),
            merge: worklist.merge(mergeSemantics)
        });
        //Tools.printMap(result, cfg);
        return body;
    }

    /**
     * @param {Set} input
     * @this {FlowNode}
     * @returns {Set} output with respect to input
     */
    function transferFunction(input) {
        if (this.type || !this.astNode) // Start and end node do not influence the result
            return input;

        // Local
        var kill = this.kill = this.kill || Tools.findVariableAssignments(this.astNode);
        var generatedDependencies = this.generate = this.generate || generateSemanticDependencies(this.astNode, kill);
        var generatedSemantics = this.generatedSemantics = this.generatedSemantics || generateNewSemantics(this.astNode);
        //generate && console.log(this.label, generate);

        // Depends on input
        var dependencies = null;
        if (generatedDependencies && generatedDependencies.deps.size) {
            var entry = input.filter(function (elem) {
                return elem.name == generatedDependencies.def;
            });
            if (entry.length) {
                dependencies = new Set();
                generatedDependencies.deps.forEach(function (dep) {
                    var obj = { name: dep, type: entry[0].type };
                    dependencies.add(obj)
                });
            }
        }

        var killed = new Set();
        kill.forEach(function (toKill) {
            killed = new Set(input.filter(function (elem) {
                return elem.name == toKill;
            }));
        });
        return mergeSemantics(Set.minus(input, killed), mergeSemantics(dependencies, generatedSemantics));
    }

    /**
     * Special merge function that merges entries with same names
     * to a new entry with top element Semantic.UNKNOWN
     * @param {Set} a
     * @param {Set} b
     * @returns {Set}
     */
    function mergeSemantics(a, b) {

        var mergeEntry = function(a, b) {
            return { name: a.name, type: a.type != b.type ? Semantic.UNKNOWN : a.type };
        };

        if (!a && b)
            return new Set(b);
        var s = new Set(a);
        if (b)
            b.forEach(
                function (elem) {
                    var name = elem.name;
                    var resultA = a.filter(function (other) {
                        return other.name == name
                    });

                    // Not in A, just add it
                    if (!resultA.length) {
                        s.add(elem);
                    } else {
                        // In A, and type is different: mergeType
                        if (resultA[0].type !== elem.type) {
                            s.add(mergeEntry(elem, resultA[0]));
                            s.delete(resultA[0]);
                        }
                    }
                }
            );
        return s;
    }


    function generateSemanticDependencies(ast, defs) {

        var defCount = defs.size;
        if (defCount == 0)
            return null;
        if (defCount > 1)
            throw new Error("Code not sanitized, found multiple definitions in one statement");

        return { def: defs.values()[0], deps: evaluateSemanticDependencies(ast) };
    }

    function evaluateSemanticDependencies(ast) {
        var result = new Set();
        if (!ast && !ast.type) {
            return result;
        }

        walker(ast, {
            AssignmentExpression: function (recurse) {
                recurse(this.right);
            },
            VariableDeclarator: function (recurse) {
                recurse(this.init);
            },
            Identifier: function () {
                result.add(this.name);
            },
            NewExpression: function () {
            },
            MemberExpression: function () {
                if (this.object.type == Syntax.Identifier && this.property.type == Syntax.Identifier) {
                    result.add(this.object.name + "." + this.property.name);
                }
            },
            CallExpression: function () {
                if (this.callee.type == Syntax.MemberExpression) {
                    var callee = this.callee;
                    if (MemberHandlers.hasOwnProperty(callee.object.name)) {
                        var propertyHandler = MemberHandlers[callee.object.name];
                        if (propertyHandler.hasOwnProperty(callee.property.name)) {
                            var handler = propertyHandler[callee.property.name];
                            result = handler(this.arguments, result);
                            return;
                        }
                    } else {
                        // Call on env
                        // TODO: This is not safe. Perform on annotated AST
                        if (Vec3Handler.hasOwnProperty(callee.property.name)) {
                            handler = Vec3Handler[callee.property.name];
                            result = handler(callee, this.arguments, result);
                            return;
                        }
                    }
                    console.log("Unhandled: ", codegen.generate(this))
                }

            }
        });
        return result;
    }

    function getName(node) {
        switch (node.type) {
            case Syntax.Identifier:
                return node.name;
            case Syntax.MemberExpression:
                return node.object.name + "." + node.property.name;
            default:
                console.error("No name for", codegen.generate(node));
                return "?"
        }
    }

    // TODO: Support more functions
    var MathHandlers = {
        mix: function (args, result) {
            result = Set.union(result, evaluateSemanticDependencies(args[0]));
            result = Set.union(result, evaluateSemanticDependencies(args[1]));
            return result;
        }
    };

    var Vec3Handler = {
        normalize: function (callee, args, result) {
            result.add(getName(callee.object));
            return result;
        },
        mul: function (callee, args, result) {
            result.add(getName(callee.object));
            result = Set.union(result, evaluateSemanticDependencies(args[0]));
            return result;
        }
    };


    var MemberHandlers = {
        "Math": MathHandlers
    };


    function generateNewSemantics(astNode) {
        var result = new Set();

        walker(astNode, {
            CallExpression: function (recurse) {
                if (this.callee.type == Syntax.MemberExpression && isBRDFCall(this.callee.object)) {
                    var name = this.callee.property.name;
                    //noinspection FallthroughInSwitchStatementJS
                    switch (name) {
                        case "diffuse":
                        case "phong":
                            declare(Semantic.COLOR, this.arguments[0], result);
                            declare(Semantic.NORMAL, this.arguments[1], result);
                            break;
                    }
                    recurse(this.callee);
                } else {
                    recurse(this.callee);
                    recurse(this.arguments);

                }
            }
        });
        return result;
    }

    function isBRDFCall(ast) {
        if (!ast) {
            return false;
        }
        if (ast.type == Syntax.NewExpression) {
            return ast.callee.type == Syntax.Identifier && ast.callee.name === "Shade";
        }
        if (ast.type == Syntax.CallExpression && ast.callee.type == Syntax.MemberExpression) {
            return isBRDFCall(ast.callee.object);
        }
        return false;
    }

    function declare(semantic, astNode, variables) {
        walker(astNode, {
            Identifier: function () {
                ANNO(this).setSemantic(semantic);
                addMerged(variables, {
                    name: this.name,
                    type: semantic
                });
            },
            MemberExpression: function () {
                if (this.object.type == Syntax.Identifier && this.property.type == Syntax.Identifier) {
                    ANNO(this).setSemantic(semantic);
                    addMerged(variables, {
                        name: getName(this),
                        type: semantic
                    });
                }
            }
        });
    }

    function addMerged(target, elem) {
        var sameName = target.filter(function (other) {
            return other.name == elem.name;
        });
        if (!sameName.length) {
            target.add(elem);
        } else {
            if (sameName[0].type !== elem.type) {
                target.add({name: elem.name, type: Semantic.UNKNOWN});
                target.delete(sameName[0]);
            }
        }
    }

    compute.Semantic = Semantic;
    module.exports = compute;

}(module));

},{"../../base/common.js":82,"./../settools.js":58,"analyses":1,"escodegen":9,"esgraph":26,"walkes":49}],58:[function(require,module,exports){

var Set = require('analyses').Set;
var walk = require('estraverse');
var codegen = require('escodegen');

var Syntax = walk.Syntax;

var Tools = {

    getSetLabels: function (s) {
        if (!s)
            return "Set: null";

        if (!s.size)
            return "Set: {}";

        return "Set: {" + s.values().map(function (n) {
            return n.label;
        }).join(", ") + "}";
    },

    printMap: function (map, cfg, cb) {
        cb = cb || JSON.stringify;
        for (var node in cfg[2]) {
            var n = cfg[2][node];
            if (n.label || n.type || !n.astNode)
                console.log(n.label || n.type, cb(map.get(n)));
            else
                console.log(codegen.generate(n.astNode), cb(map.get(n)));
        }
    },

    findVariableAssignments: function (ast, ignoreUninitalizedDeclarations) {
        var definitions = new Set();
        walk.traverse(ast, {
            leave: function (node, parent) {
                switch (node.type) {
                    case Syntax.AssignmentExpression:
                        if (node.left.type == Syntax.Identifier) {
                            definitions.add(node.left.name);
                        }
                        break;
                    case Syntax.VariableDeclarator:
                        if (node.id.type == Syntax.Identifier && (!ignoreUninitalizedDeclarations || node.init)) {
                            definitions.add(node.id.name);
                        }
                        break;
                    case Syntax.UpdateExpression:
                        if (node.argument.type == Syntax.Identifier) {
                            definitions.add(node.argument.name);
                        }
                        break;
                }
            }
        })
        return definitions;
    }

}

module.exports = Tools;



},{"analyses":1,"escodegen":9,"estraverse":42}],59:[function(require,module,exports){
(function (module) {

    // dependencies
    var walker = require('walkes');
    var worklist = require('analyses');
    var common = require("../base/common.js");
    var esgraph = require('esgraph');
    var codegen = require('escodegen');
    var Tools = require("./settools.js");
    var Shade = require("./../interfaces.js"),
        SpaceType = Shade.SpaceType,
        VectorType = Shade.VectorType,
        SpaceVectorType = Shade.SpaceVectorType;


    // shortcuts
    var Syntax = common.Syntax;
    var Set = worklist.Set,
        Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS;

    // defines


    var c_resultPointOk = true, c_resultNormalOk = true,
        c_customFunctionPropagations = null, c_debug = false;

    function analyze(functionAast, customFunctionPropagations) {
        var cfg = esgraph(functionAast.body, { omitExceptions: true });
        c_resultPointOk = true; c_resultNormalOk = true;
        c_customFunctionPropagations = customFunctionPropagations || {};
        var output = worklist(cfg, transferSpaceInfo, {
            direction: 'backward',
            start: null,
            merge: worklist.merge(mergeSpaceInfo)
        });
        var startNodeResult = output.get(cfg[0]);
        var result = {};
        var tranferEntry = {
            transferPointOk: c_resultPointOk,
            transferNormalOk: c_resultNormalOk,
            transferArgs: []
        };
        var transferSpaces = {};
        startNodeResult.forEach(function(elem) {
            var split = elem.split(";"), name = split[0], space = split[1]*1;
            if(Shade.getSpaceFromSpaceVector(space) == SpaceType.RESULT){
                transferSpaces[name] = true;
                return;
            }
            if(!result[name]) result[name] = [];
            result[name].push(space);
        });
        for(var i = 0; i < functionAast.params.length; ++i){
            var name = functionAast.params[i].name;
            tranferEntry.transferArgs.push( transferSpaces[name]);
        }
        c_customFunctionPropagations[functionAast.id.name] = tranferEntry;
        return result;
    }


    function setSpaceInfo(ast, key, value){
        if(!ast.spaceInfo)
            ast.spaceInfo = {};
        ast.spaceInfo[key] = value;
    }
    function setSpaceInfoSpaces(ast, key, spaces){
        var values = spaces && spaces.filter(function(space){ return Shade.getSpaceFromSpaceVector(space) != SpaceType.RESULT });
        setSpaceInfo(ast, key, values);
    }

    /**
     * @param {Set} input
     * @this {FlowNode}
     * @returns {Set} output with respect to input
     */
    function transferSpaceInfo(input) {
        if (this.type || !this.astNode) // Start and end node do not influence the result
            return input;

        // Local
        var kill = this.kill = this.kill || Tools.findVariableAssignments(this.astNode, true);
        var generatedDependencies = this.generate = this.generate || generateSpaceDependencies(this.astNode, kill);
        //generate && console.log(this.label, generate);

        // Depends on input
        var depSpaceInfo = new Set(), finalSpaces = null, spaceTypes = null;
        setSpaceInfo(this.astNode, "transferSpaces", null);
        setSpaceInfo(this.astNode, "hasSpaceOverrides", generatedDependencies.dependencies.spaceOverrides.length > 0);
        if(generatedDependencies.def){
            var def = generatedDependencies.def;
            setSpaceInfo(this.astNode, "def", def);
            spaceTypes = getSpaceVectorTypesFromInfo(input, def);
        }
        else{
            spaceTypes = new Set([SpaceVectorType.OBJECT])
            if(this.astNode.type == Syntax.ReturnStatement){
                spaceTypes.add(SpaceVectorType.RESULT_NORMAL);
                spaceTypes.add(SpaceVectorType.RESULT_POINT);
            }
        }
        setSpaceInfoSpaces(this.astNode, "transferSpaces", spaceTypes);
        finalSpaces = createSpaceInfoFromDependencies(depSpaceInfo, generatedDependencies.dependencies, spaceTypes);
        setSpaceInfoSpaces(this.astNode, "finalSpaces", (finalSpaces && finalSpaces.size > 0) ? finalSpaces : null);

        input = new Set(input.filter(function (elem) {
            return !kill.has(elem.split(";")[0]);
        }));
        return mergeSpaceInfo(input, depSpaceInfo);
    }

    function getSpaceVectorTypesFromInfo(spaceInfo, identifier){
        var set = new Set(spaceInfo.filter(function(elem){return elem.split(";")[0] == identifier}).map(function(elem){ return elem.split(";")[1]*1}));
        if(set.size == 0)
            set.add(SpaceVectorType.OBJECT);
        return set;
    }
    function isSpaceTypeValid(spaceType, dependencies){
        var type = Shade.getVectorFromSpaceVector(spaceType);
        return type == VectorType.NONE || (type == VectorType.NORMAL && !dependencies.normalSpaceViolation)
           || (type == VectorType.POINT && !dependencies.pointSpaceViolation);
    }

    function createSpaceInfoFromDependencies(depSpaceInfo, dependencies, spaces){
        var finalSpaces = new Set();
        dependencies.toObjectSet.forEach(function(name){
            depSpaceInfo.add(  name + ";" + SpaceVectorType.OBJECT);
        })
        spaces.forEach(function(spaceVector){
            var space = Shade.getSpaceFromSpaceVector(spaceVector);
            var isValid = isSpaceTypeValid(spaceVector, dependencies);

            if(space != SpaceType.OBJECT && dependencies.hasDirectVec3SpaceOverride()){
                if(space == SpaceType.RESULT)
                    isValid = false;
                else
                    throw new Error("Detection of repeated space conversion. Not supported!");
            }

            finalSpaces.add(spaceVector);

            if(!isValid && space == SpaceType.RESULT){
                if(Shade.getVectorFromSpaceVector(spaceVector) == VectorType.NORMAL)
                    c_resultNormalOk = false;
                else
                    c_resultPointOk = false;
            }
            spaceVector = isValid ?  spaceVector : SpaceVectorType.OBJECT;

            dependencies.propagateSet.forEach(function(name){
                depSpaceInfo.add( name + ";"  + spaceVector );
            });
        });
        var overrides = dependencies.spaceOverrides;
        for(var i = 0; i < overrides.length; ++i){
            createSpaceInfoFromDependencies(depSpaceInfo, overrides[i].dependencies, new Set( [overrides[i].space] ));
        }
        return finalSpaces;
    }


    /**
     * Special merge function that merges entries with same names
     * to a new entry with top element Semantic.UNKNOWN
     * @param {Set} a
     * @param {Set} b
     * @returns {Set}
     */
    function mergeSpaceInfo(a, b) {
        var s = a ? new Set(a) : new Set();
        if (b)
            b.forEach(
                function (elem) {
                    s.add(elem);
                }
            );
        return s;
    }

    function SpaceDependencies(){
        this.normalSpaceViolation = false;
        this.pointSpaceViolation = false;
        this.propagateSet = new Set();
        this.toObjectSet = new Set();
        this.spaceOverrides = [];
    }

    SpaceDependencies.prototype.addSpaceOverride = function(space, fromObjectSpace, dependencies){
        this.spaceOverrides.push({ space: space, fromObjectSpace: fromObjectSpace, dependencies: dependencies})
    }
    SpaceDependencies.prototype.hasDirectVec3SpaceOverride = function(){
        var i = this.spaceOverrides.length;
        while(i--){
            if(!this.spaceOverrides[i].fromObjectSpace)
                return true;
        }
        return false;
    }


    function generateSpaceDependencies(ast, defs) {
        var result = {def: null, dependencies: new SpaceDependencies()};
        if (!ast && !ast.type)
            return result;
        var defCount = defs.size;
        if (defCount > 1)
            throw new Error("Code not sanitized, found multiple definitions in one statement");
        if(defCount == 1)
            result.def = defs.values()[0];
        // TODO: Properly determine FLOAT3 statements
        var isFloat3Statement = (ast.extra && ast.extra.kind == Kinds.FLOAT3);

        if(isFloat3Statement){
            gatherSpaceDependencies(ast, result.dependencies);
            setSpaceInfo(ast, "propagateSet", result.dependencies.propagateSet.values());
            setSpaceInfo(ast, "normalSpaceViolation", result.dependencies.normalSpaceViolation);
            setSpaceInfo(ast, "pointSpaceViolation", result.dependencies.pointSpaceViolation);
        }
        else
            gatherObjectDependencies(ast, result.dependencies);

        return result;
    }

    function getSpaceConversion(callAst){
        var callee = callAst.callee;
        if(callee.type == Syntax.MemberExpression && callee.object.type == Syntax.Identifier
            && callee.object.name == "Space"){
            var spaceType = 0;
            switch(callee.property.name){
                case "transformPoint": spaceType = VectorType.POINT; break;
                case "transformDirection": spaceType = VectorType.NORMAL; break;
            }
            spaceType = spaceType << 3;
            if(spaceType){
                var firstArg = callAst.arguments[0];

                if(firstArg.type != Syntax.MemberExpression || firstArg.object.type != Syntax.Identifier
                    || firstArg.object.name != "Space" || firstArg.property.type != Syntax.Identifier)
                    throw new Error("The first argument of '" + callee.property + "' must be a Space enum value.");
                switch(firstArg.property.name){
                    case "VIEW" : spaceType += SpaceType.VIEW; break;
                    case "WORLD": spaceType += SpaceType.WORLD; break;
                }
                return spaceType;
            }
        }
        return null;
    }

    function handleSpaceOverride(callAst, result, fromObjectSpace){
        var space = getSpaceConversion(callAst);
        if(space){
            var subResult = new SpaceDependencies();
            gatherSpaceDependencies(callAst.arguments[1], subResult);
            result.addSpaceOverride(space, fromObjectSpace, subResult);
            setSpaceInfo(callAst, "spaceOverride", space);
            setSpaceInfo(callAst, "propagateSet", subResult.propagateSet.values());
            setSpaceInfo(callAst, "normalSpaceViolation", subResult.normalSpaceViolation);
            setSpaceInfo(callAst, "pointSpaceViolation", subResult.pointSpaceViolation);
            return true;
        }
        return false;
    }

    function gatherObjectDependencies(ast, result){
        walker(ast, {
            VariableDeclaration: function(){},
            Identifier: function(){
                if(this.extra.kind == Kinds.FLOAT3){
                    result.toObjectSet.add(this.name);
                }

            },
            MemberExpression: function (recurse) {
                if(this.extra.kind == Kinds.FLOAT3){
                    if (this.object.type == Syntax.Identifier && this.property.type == Syntax.Identifier) {
                        if(this.object.extra.global)
                            result.propagateSet.add("env." + this.property.name);
                        else if(this.object.name !== "uexp") { // FIXME
                            throw new Error("Member Access of non 'env' object in space equation - not supported: " + codegen.generate(this));
                        }
                    }
                }
                else{
                    recurse(this.object);
                    recurse(this.property);
                }
            },
            CallExpression: function (recurse) {
                if(handleSpaceOverride(this, result, true))
                    return;
                recurse(this.callee);
                this.arguments.map(recurse);
            }
        });
    }

    function gatherSpaceDependencies(ast, result) {
        walker(ast, {
            VariableDeclaration: function(){},
            AssignmentExpression: function (recurse) {
                recurse(this.right);
            },
            Identifier: function () {
                if(this.extra.kind == Kinds.FLOAT3){
                    result.propagateSet.add(this.name);
                    setSpaceInfo(this, "propagate", true);
                }
             },
            NewExpression: function (recurse) {
                if(this.callee == "Vec3"){
                    handleVec3Args(this.arguments, recurse, result, false);
                }
            },
            MemberExpression: function (recurse) {
                if(this.extra.kind == Kinds.FLOAT3){
                    if (this.object.type == Syntax.Identifier && this.property.type == Syntax.Identifier) {
                        if(this.object.extra.global)
                            result.propagateSet.add("env." + this.property.name);
                        else if(this.object.name !== "uexp") { // FIXME
                            throw new Error("Member Access of non 'env' object in space equation - not supported.")
                        }
                        setSpaceInfo(this, "propagate", true);
                    }
                }
                else{
                    recurse(this.object);
                    recurse(this.property);
                }
            },
            CallExpression: function (recurse) {
                if(handleSpaceOverride(this, result, false))
                    return;
                if (this.callee.type == Syntax.MemberExpression) {
                    result.pointSpaceViolation = true;
                    var callObject = this.callee.object;
                    var objectKind = callObject.extra.kind,
                        method = this.callee.property.name,
                        args = this.arguments;
                    if(PropagationRules[objectKind] && PropagationRules[objectKind][method]){
                        PropagationRules[objectKind][method](callObject, args, recurse, result);
                        return;
                    }
                    c_debug && console.log("Unhandled: ", codegen.generate(this))
                }else if(this.callee.type == Syntax.Identifier){
                    var id = this.callee.name;
                    var customEntry = c_customFunctionPropagations && c_customFunctionPropagations[id];
                    if(customEntry){
                        if(!customEntry.transferPointOk) result.pointSpaceViolation = true;
                        if(!customEntry.transferNormalOk) result.normalSpaceViolation = true;
                        var i = customEntry.transferArgs.length;
                        while(i--){
                            if(customEntry.transferArgs[i])
                                recurse(this.arguments[i]);
                            else
                                gatherObjectDependencies(this.arguments[i], result);
                        }
                        return;
                    }
                }
                result.pointSpaceViolation = true;
                result.normalSpaceViolation = true;
                gatherObjectDependencies(this, result);
                //this.arguments.forEach(function(arg){ gatherObjectDependencies(arg, result)});
            }
        });
    }

    function handleScaleOperator(callObject, args, recurse, result){
        handleVec3Args(args, recurse, result, true);
        recurse(callObject);
    }
    function handleAddSubOperation(callObject, args, recurse, result){
        handleVec3Args(args, recurse, result, false);
        recurse(callObject);
    }

    function handleVec3Args(args, recurse, result, scaling){
        if(!scaling && args.length == 0){
            result.normalSpaceViolation = true;
            return;
        }
        if(args.length > 1){
            result.normalSpaceViolation = true;
            return;
        }
        if(args.length == 1){
            if(args[0].extra.kind == Kinds.FLOAT3){
                recurse(args[0]);
            }
            else if(scaling && typeIsScalar(args[0].extra.type)){
                gatherObjectDependencies(args[0], result);
            }
            else{
                result.normalSpaceViolation = true;
            }
        }
    }

    function typeIsScalar(type){
        return type == Types.NUMBER || type == Types.INT;
    }


    var PropagationRules = {
        "float3" : {
            "add" : handleAddSubOperation,
            "sub" : handleAddSubOperation,
            "cross" : handleAddSubOperation,
            "mul" : handleScaleOperator,
            "div" : handleScaleOperator,
            "normalize" : handleScaleOperator
        }
    }
    module.exports = {
        analyze: analyze
    };

}(module));

},{"../base/common.js":82,"./../interfaces.js":111,"./settools.js":58,"analyses":1,"escodegen":9,"esgraph":26,"walkes":49}],60:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var common = require("../../base/common.js"),
        Shade = require("../../interfaces.js"),
        evaluator = require("../constants/evaluator.js"),
        estraverse = require('estraverse'),
        ErrorHandler = require("../../base/errors.js");

    var codegen = require('escodegen');

    // Shortcuts
    var Syntax = common.Syntax,
        TYPES = Shade.TYPES,
        ANNO = common.ANNO,
        generateErrorInformation = ErrorHandler.generateErrorInformation,
        ERROR_TYPES = ErrorHandler.ERROR_TYPES;

    var debug = false;



    var handlers = {

        ArrayExpression: function (node, parent, context) {
            var result = ANNO(node), elements = context.getTypeInfo(node.elements), elementType = ANNO({});

            result.setType(TYPES.ARRAY);
            elements.forEach(function (element, index) {
                if (!index) {
                    elementType.copy(element);
                } else {
                    if (!elementType.setCommonType(elementType, element)) {
                        result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "shade.js does not support inhomogenous arrays: [", elements.map(function (e) {
                            return e.getTypeString()
                        }).join(", "), "]"));
                    }
                }
            });
        },

        /**
         * @param node
         */
        Literal: function (node) {
            var value = node.raw !== undefined ? node.raw : node.value,
                result = ANNO(node);

            var number = parseFloat(value);
            if (!isNaN(number)) {
                if (value.toString().indexOf(".") == -1) {
                    result.setType(TYPES.INT);
                }
                else {
                    result.setType(TYPES.NUMBER);
                }
            } else if (value === 'true' || value === 'false') {
                result.setType(TYPES.BOOLEAN);
            } else if (value === 'null') {
                result.setType(TYPES.NULL);
            } else {
                result.setType(TYPES.STRING);
            }
            if (!result.isNull()) {
                result.setStaticValue(evaluator.getStaticValue(node));
            }
        },

        /**
         * ExpressionStatement: Just copy the result from the actual expression
         */
        ExpressionStatement: function (node) {
            var result = ANNO(node),
                expression = ANNO(node.expression);
            result.copy(expression);
        },


        /**
         * ReturnStatement: If return has an argument, copy the TypeInfo
         * form the argument, otherwise it's undefined. Inform the scope on
         * the return type of this return branch.
         */
        ReturnStatement: function (node, parent, context) {
            var result = ANNO(node),
                argument = context.getTypeInfo(node.argument);

            if (argument) {
                result.copy(argument);
            } else {
                result.setType(TYPES.UNDEFINED);
            }
            context.getScope().updateReturnInfo(result);
        },

        /**
         * NewExpression: Find the type of the Callee from
         * the scope and evaluate based on annotated parameters
         */
        NewExpression: function(node, parent, context) {
            var result = ANNO(node), staticValue;

            // Be on the safe side, assume result is static independently of former annotations
            result.setDynamicValue();

            var scope = context.getScope();
            var entry = scope.getBindingByName(node.callee.name);
            if (entry && entry.hasConstructor()) {
                var constructor = entry.getConstructor();
                var args = context.getTypeInfo(node.arguments);
                try {
                    var extra = constructor.evaluate(result, args, scope);
                    result.setFromExtra(extra);
                } catch (e) {
                    result.setInvalid(e);
                    return;
                }
                if (constructor.computeStaticValue) {
                    try {
                        staticValue = constructor.computeStaticValue(result, context.getTypeInfo(node.arguments), scope);
                        if (staticValue !== undefined) {
                            result.setStaticValue(staticValue);
                        }
                    } catch (e) {
                        result.setDynamicValue();
                    }
                }
            }
            else {
                result.setInvalid(generateErrorInformation(node, ERROR_TYPES.REFERENCE_ERROR, node.callee.name, "is not defined"));
            }
        },


        /**
         * UnaryExpression
         */
        UnaryExpression: function (node, parent, context) {
            var result = ANNO(node),
                argument = context.getTypeInfo(node.argument),
                operator = node.operator;

            //noinspection FallthroughInSwitchStatementJS
            switch (operator) {
                case "!":
                    result.setType(TYPES.BOOLEAN);
                    if (argument.canObject()) {
                        result.setStaticValue(false); // !obj == false
                        return;
                    }
                    break;
                case "+":
                case "-":
                    if (argument.canInt()) {
                        result.setType(TYPES.INT);
                    } else if (argument.canNumber()) {
                        result.setType(TYPES.NUMBER);
                    } else {
                        result.setInvalid(generateErrorInformation(node, ERROR_TYPES.NAN_ERROR));
                    }
                    break;
                case "typeof":
                    result.setType(TYPES.STRING);
                    if(argument.isValid())
                        result.setStaticValue(argument.getJavaScriptTypeString());
                    return;

                case "~":
                case "void":
                case "delete":
                default:
                    result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, operator, "is not supported."));
            }
            if (argument.hasStaticValue()) {
                result.setStaticValue(evaluator.getStaticValue(node));
            } else {
                result.setDynamicValue();
            }
        },

        /**
         * 'Undefined' is an identifier. Variables, names of functions and
         * member properties are handled within parent expressions
         */
        Identifier: function (node) {
            if (node.name === "undefined") {
                ANNO(node).setType(TYPES.UNDEFINED);
            }
        },

        /**
         * BinaryExpression
         */
        BinaryExpression: function (node, parent, context) {
            //console.log(node.left, node.right);
            var left = context.getTypeInfo(node.left),
                right = context.getTypeInfo(node.right),
                result = ANNO(node),
                operator = node.operator,
                value;

            if(!(left.isValid() && right.isValid())) {
                result.setInvalid();
                return;
            }

            //noinspection FallthroughInSwitchStatementJS
            switch (operator) {
                case "+":
                case "-":
                case "*":
                case "/":
                case "%":
                    // int 'op' int => int
                    // int / int => number
                    if (left.canInt() && right.canInt()) {
                        if (operator == "/")
                            result.setType(TYPES.NUMBER);
                        else
                            result.setType(TYPES.INT);
                    }
                    // int 'op' number => number
                    else if (left.canInt() && right.isNumber() || right.canInt() && left.isNumber()) {
                        result.setType(TYPES.NUMBER);
                    }
                    // number 'op' number => number
                    else if (left.isNumber() && right.isNumber()) {
                        result.setType(TYPES.NUMBER);
                        // int 'op' null => int
                    }
                    else if (left.isInt() && right.isNull() || right.isInt() && left.isNull()) {
                        result.setType(TYPES.INT);
                    }
                    // number 'op' null => number
                    else if ((left.isNumber() && right.isNull()) || (right.isNumber() && left.isNull())) {
                        result.setType(TYPES.NUMBER);
                    }
                    else {
                        // NaN

                       var message = "";
                       // Special handling for undefined, as this is the main reason for this error
                       if(left.isNullOrUndefined()) {
                            message = codegen.generate(node.left) + " is undefined";
                       } else if (right.isNullOrUndefined()) {
                            message = codegen.generate(node.right) + " is undefined";
                       }
                        result.setInvalid(generateErrorInformation(node, ERROR_TYPES.NAN_ERROR, message));
                    }
                    break;
                case "===":
                case "!==":
                    result.setType(TYPES.BOOLEAN);
                    if (left.isUndefined() || right.isUndefined()) {
                        value = left.isUndefined() && right.isUndefined();
                        result.setStaticValue(operator == "===" ? value : !value);
                        return;
                    }
                    break;
                case "==": // comparison
                case "!=":
                case ">":
                case "<":
                case ">=":
                case "<=":
                    result.setType(TYPES.BOOLEAN);
                    if (left.isUndefined() || right.isUndefined()) {
                        value = left.isUndefined() && right.isUndefined();
                        result.setStaticValue(operator == "!=" ? !value : value);
                        return;
                    }
                    break;
                default:
                    result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, operator, "is not supported."));
                    return;
            }
             if (left.hasStaticValue() && right.hasStaticValue()) {
                //console.log(left.getStaticValue(), operator, right.getStaticValue());
                result.setStaticValue(evaluator.getStaticValue(node));
            } else {
                result.setDynamicValue();
            }
        },

        UpdateExpression: function(node, parent, context) {
            var argument = context.getTypeInfo(node.argument),
                result = ANNO(node);
            if(argument.canNumber()) {
                result.copy(argument);
                if(node.prefix && argument.hasStaticValue()) {
                    if(node.operator == "++") {
                        result.setStaticValue(argument.getStaticValue()+1)
                    } else if(node.operator == "--") {
                        result.setStaticValue(argument.getStaticValue()-1)
                    } else {
                        throw new Error("Operator not supported: " + node.operator);
                    }
                }
            } else {
                // e.g. var a = {}; a++;
                result.setInvalid(generateErrorInformation(node, ERROR_TYPES.NAN_ERROR));
            }
        },

        AssignmentExpression: function (node, parent, context) {
            var right = context.getTypeInfo(node.right),
                result = ANNO(node);

            result.copy(right);
            result.setDynamicValue();
            result.clearUniformDependencies();

            // Check, if a assigned variable still has the same type as
            // before and update type of uninitialized variables.
            if (node.left.type == Syntax.Identifier && !context.inDeclaration() && right.isValid()) {
                var name = node.left.name;
                var scope = context.getScope();
                scope.updateTypeInfo(name, right, node);
            }
        },


        MemberExpression: function (node, parent, context) {
            var resultType = context.getTypeInfo(node),
                objectAnnotation = ANNO(node.object),
                propertyAnnotation = ANNO(node.property),
                scope = context.getScope();

            if(!objectAnnotation.isValid()) {
                resultType.setInvalid();
                return;
            }

            //console.log("Member", node.object.name, node.property.name, node.computed);
            if (node.computed) {
                if (objectAnnotation.isArray()) {
                    // Property is computed, thus it could be a variable
                    var propertyType =  context.getTypeInfo(node.property);
                    if (!propertyType.canInt()) {
                        Shade.throwError(node, "Expected 'int' type for array accessor");
                    }
                    var elementInfo = objectAnnotation.getArrayElementType();
                    resultType.setType(elementInfo.type, elementInfo.kind);
                    return;
                }
                else {
                    resultType.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "no array access to object yet"));
                    return;
                    //Shade.throwError(node, "TypeError: Cannot access member via computed value from object '" + objectAnnotation.getTypeString());
                }
            }
            var propertyName = node.property.name;

            var objectOfInterest = common.getObjectReferenceFromNode(node.object, scope);

            objectOfInterest || Shade.throwError(node,"ReferenceError: " + node.object.name + " is not defined. Context: " + scope.str());

            if (!objectOfInterest.isValid() || objectOfInterest.getType() == TYPES.UNDEFINED) {  // e.g. var a = undefined; a.unknown;
                resultType.setInvalid(generateErrorInformation(node, ERROR_TYPES.TYPE_ERROR, "Cannot read property '" + propertyName + "' of undefined"));
                return;
            }
            if (objectOfInterest.getType() != TYPES.OBJECT) { // e.g. var a = 5; a.unknown;
                resultType.setType(TYPES.UNDEFINED);
                return;
            }

            var objectInfo = scope.getObjectInfoFor(objectOfInterest);
            if(!objectInfo) {
                resultType.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "Internal: Incomplete registration for object:", objectOfInterest.getTypeString(), ",", JSON.stringify(node.object)));
                return;
            }

            objectAnnotation.copy(objectOfInterest);
            if (!objectInfo.hasOwnProperty(propertyName)) {
                resultType.setType(TYPES.UNDEFINED);
                propertyAnnotation.setType(TYPES.UNDEFINED);
                return;
            }

            var propertyTypeInfo = objectInfo[propertyName];
            propertyAnnotation.setFromExtra(propertyTypeInfo);
            resultType.copy(propertyAnnotation);
        },

        CallExpression: function (node, parent, context) {
            var result = ANNO(node),
                scope = context.getScope(),
                args = context.getTypeInfo(node.arguments),
                extra, staticValue;

            if (!args.every(function (arg) {return arg.isValid() })) {
                result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "Not all arguments types of call expression could be evaluated"));
                return;
            }
            // Be on the safe side, assume result is static independently of former annotations
            result.setDynamicValue();

            // Call on an object, e.g. Math.cos()
            if (node.callee.type == Syntax.MemberExpression) {

                var memberExpression = context.getTypeInfo(node.callee);
                if(!memberExpression.isValid()) {
                    result.setInvalid();
                    return;
                }

                var object = node.callee.object,
                    propertyName = node.callee.property.name;

                var objectReference = context.getTypeInfo(object);
                if(!objectReference)  {
                    Shade.throwError(node, "Internal: No object info for: " + object);
                }
                var objectInfo = scope.getObjectInfoFor(objectReference);
                if(!objectInfo) { // Every object needs an info, otherwise we did something wrong
                    Shade.throwError(node, "Internal Error: No object registered for: " + objectReference.getTypeString() + JSON.stringify(node.object));
                }

                if (!memberExpression.isFunction()) { // e.g. Math.PI()
                    if (objectInfo.hasOwnProperty(propertyName)) {
                      result.setInvalid(generateErrorInformation(node, ERROR_TYPES.TYPE_ERROR, "Property '" + propertyName + "' of object #<"+ objectReference.getTypeString() +"> is not a function"));
                    } else {
                      result.setInvalid(generateErrorInformation(node, ERROR_TYPES.TYPE_ERROR, (object.type == Syntax.ThisExpression ? "'this'" : objectReference.getTypeString())+ " has no method '"+ propertyName + "'"));
                    }
                    return;
                }


                if (!objectInfo.hasOwnProperty(propertyName)) {
                    result.setType(TYPES.UNDEFINED);
                    return;
                }
                var propertyHandler = objectInfo[propertyName];

                if (typeof propertyHandler.evaluate != "function") {
                    Shade.throwError(node, "Internal: no handler registered for '" + propertyName + "'");
                }
                // Evaluate type of call

                try {
                    extra = propertyHandler.evaluate(result, args, scope, objectReference, context);
                    result.setFromExtra(extra);
                } catch (e) {
                    result.setInvalid(generateErrorInformation(node, e.message));
                    return;
                }

                // If we have a type, evaluate static value
                if (typeof propertyHandler.computeStaticValue != "function") {
                    debug && console.warn("No static evaluation exists for function", codegen.generate(node));
                    return;
                }
                staticValue = propertyHandler.computeStaticValue(result, args, scope, objectReference, context);
                if (staticValue !== undefined) {
                    result.setStaticValue(staticValue);
                }
                return;

            }  else if (node.callee.type == Syntax.Identifier) {
                var functionName = node.callee.name;
                var func = scope.getBindingByName(functionName);
                if (!func) {
                    result.setInvalid(generateErrorInformation(node, ERROR_TYPES.REFERENCE_ERROR, functionName,  "is not defined"));
                    return;
                }
                if(!func.isFunction()) {
                    result.setInvalid(generateErrorInformation(node, ERROR_TYPES.TYPE_ERROR, func.getTypeString(), "is not a function"));
                    return;
                }
                try {
                    extra = context.callFunction(scope.getVariableIdentifier(functionName), args);
                    extra && result.setFromExtra(extra);
                } catch(e) {
                    result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "Failure in function call: ", e.message));
                }
                return;
            }
            result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "Internal:", "Unhandled CallExpression", node.callee.type));
        },

        VariableDeclarator: function (node, parent, context) {
            var init = node.init ? context.getTypeInfo(node.init) : null,
                result = ANNO(node);
            if(init) {
                ANNO(node.init).copy(init);
                result.copy(init);
            }
        },

        VariableDeclaration: function (node, parent, context) {
            context.setInDeclaration(false);
        },

        LogicalExpression: function (node, parent, context) {
            var left = context.getTypeInfo(node.left),
                right = context.getTypeInfo(node.right),
                result = ANNO(node);


            // static: true || false, dynamic: undefined
            var leftBool = left.getStaticTruthValue(),
                rightBool = right.getStaticTruthValue(),
                operator = node.operator;

            if (operator === "||") {
                if (leftBool === false) {
                    result.copy(right);
                    return;
                }
                if (leftBool === true) {
                    result.copy(left);
                    return;
                }
                // Left is dynamic, let's check right
                if (rightBool === false) {
                    // Now the result type is always the one of the left value
                    result.copy(left);
                    return;
                }
            } else if (operator === "&&") {
                if (leftBool === false) {
                    // T(x) == false => x && y == x
                    result.copy(left);
                    return;
                }
                if (leftBool === true) {
                    result.copy(right);
                    return;
                }
                // Left is dynamic, let's check right
                if (rightBool === true) {
                    // Now the result type is always the one of the left value
                    result.copy(left);
                    return;
                }
                if (rightBool === false) {
                    // Now the result must be false
                    result.setType(TYPES.BOOLEAN);
                    result.setStaticValue(false);
                    return;
                }
            }

            // If we can cast both sides to a common type, it's fine
            if(result.setCommonType(left, right)) {
                return;
            }
            result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "Can't evaluate polymorphic logical expression"));
        },

        ConditionalExpression: function (node, parent, context) {
            var consequent = context.getTypeInfo(node.consequent),
                alternate = context.getTypeInfo(node.alternate),
                test = context.getTypeInfo(node.test),
                result = ANNO(node);

            var testResult = test.getStaticTruthValue();
            if(testResult === true) {
                result.copy(consequent);
            } else if (testResult === false) {
                result.copy(alternate);
            } else {
                if (result.setCommonType(consequent, alternate)) {
                    result.setDynamicValue();
                } else {
                    result.setInvalid(generateErrorInformation(node, ERROR_TYPES.SHADEJS_ERROR, "Can't evaluate polymorphic conditional expression"))
                }
            }

        }

    };

    ns.annotateRight  = function(context, ast, propagatedConstants) {

        if(!ast)
            throw Error("No node to analyze");

        var controller = new estraverse.Controller();

        context.setConstants(propagatedConstants || null);

        controller.traverse(ast, {
            enter: function(node) {
                if(node.type == Syntax.VariableDeclaration) {
                    context.setInDeclaration(true);
                }
            },
            leave: function(node, parent) {
                if (handlers.hasOwnProperty(node.type)) {
                    return handlers[node.type].call(this, node, parent, context);
                }
                return null;
            }
        });

        context.setConstants(null);

    }
}(exports));

},{"../../base/common.js":82,"../../base/errors.js":84,"../../interfaces.js":111,"../constants/evaluator.js":53,"escodegen":9,"estraverse":42}],61:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var ColorClosureInstance = {
        mul: {
            type: TYPES.FUNCTION,
            evaluate: function() {
                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        add: {
            type: TYPES.FUNCTION,
            evaluate: function() {
                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        }
    };

    Tools.extend(ns, {
        id: "ColorClosure",
        kind: KINDS.COLOR_CLOSURE,
        object: {
            constructor: null,
            static: null
        },
        instance: ColorClosureInstance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],62:[function(require,module,exports){
(function (ns) {

    var Scope = require("../../../base/scope.js"),
        Base = require("../../../base/index.js");


    var objects = {
        Shade : require("./shade.js"),
        Space : require("./space.js"),
        Math : require("./math.js"),
        Vec2 : require("./vec2.js"),
        Vec3 : require("./vec3.js"),
        Color: require("./vec3.js"),
        Vec4 : require("./vec4.js"),
        Mat3 : require("./mat3.js"),
        Mat4 : require("./mat4.js"),
        Texture : require("./texture.js"),
        ColorClosure: require("./colorclosure.js")
    };

    var Registry = {
        name: "TypeInference",
        getByName: function(name) {
            var result = objects[name];
            return result || null;
        },
        getInstanceForKind: function(kind) {
            for(var obj in objects) {
                if (objects[obj].kind == kind) {
                    return objects[obj].instance;
                }
            }
            return null;
        }
    };


    /**
     * @constructor
     * @extends {Scope}
     */
    var InferenceScope = function(node, parentScope, opt) {
        opt = opt || {};
        Base.extend(opt, { registry: Registry });
        Scope.call(this, node, parentScope, opt);
    }

    Base.createClass(InferenceScope, Scope, {

        registerGlobals: function() {
            this.registerObject("Math", objects.Math);
            this.registerObject("Color",  objects.Color);
            this.registerObject("Vec2", objects.Vec2);
            this.registerObject("Vec3", objects.Vec3);
            this.registerObject("Vec4", objects.Vec4);
            this.registerObject("Texture", objects.Texture);
            this.registerObject("Shade", objects.Shade);
            this.registerObject("Space", objects.Space);
            this.registerObject("Mat3", objects.Mat3);
            this.registerObject("Mat4", objects.Mat4);
            this.declareVariable("_env");
        }

    });

    exports.InferenceScope = InferenceScope;

}(exports));

},{"../../../base/index.js":85,"../../../base/scope.js":86,"./colorclosure.js":61,"./mat3.js":63,"./mat4.js":64,"./math.js":65,"./shade.js":66,"./space.js":67,"./texture.js":69,"./vec2.js":71,"./vec3.js":72,"./vec4.js":73}],63:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var Matrix3Constructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.MATRIX3,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: Tools.Mat.matConstructorEvaluate.bind(null, "Mat3")
    };

    var Matrix3StaticObject = {
    };

    var Matrix3Instance = {
        col: {
            type: TYPES.FUNCTION,
            evaluate: Tools.Mat.colEvaluate.bind(null, "Mat3")
        }
    };
    Tools.Mat.attachMatMethods(Matrix3Instance, "Mat3", ['add', 'sub', 'mul', 'div']);
    Tools.Vec.attachVecMethods(Matrix3Instance, "Mat3", 3, 3, ['mulVec']);


    Tools.extend(ns, {
        id: "Mat3",
        kind: KINDS.MATRIX3,
        object: {
            constructor: Matrix3Constructor,
            static: Matrix3StaticObject
        },
        instance: Matrix3Instance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],64:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var Matrix4Constructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.MATRIX4,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: Tools.Mat.matConstructorEvaluate.bind(null, "Mat4")
    };

    var Matrix4StaticObject = {
    };

    var Matrix4Instance = {
        col: {
            type: TYPES.FUNCTION,
            evaluate: Tools.Mat.colEvaluate.bind(null, "Mat4")
        }
    };
    Tools.Mat.attachMatMethods(Matrix4Instance, "Mat4", ['add', 'sub', 'mul', 'div']);
    Tools.Vec.attachVecMethods(Matrix4Instance, "Mat4", 4, 4, ['mulVec']);


    Tools.extend(ns, {
        id: "Mat4",
        kind: KINDS.MATRIX4,
        object: {
            constructor: Matrix4Constructor,
            static: Matrix4StaticObject
        },
        instance: Matrix4Instance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],65:[function(require,module,exports){
(function (ns) {

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        Base = require("../../../base/index.js"),
        Tools = require("./tools.js");


    var notStatic = function() {};

    var evaluateStatic = function(name) {
        return function (result, args) {
            if (Tools.allArgumentsAreStatic(args)) {
                var callArgs = args.map(function (a) {
                    return a.getStaticValue();
                });
                return Math[name].apply(null, callArgs);
            }
        }
    }

    var evaluateMethod = function (name, paramCount, returnType) {
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        return function (result, args, ctx) {
            if (paramCount != -1) { // Arbitrary number of arguments
                if (!args || args.length != paramCount) {
                    throw new Error("Invalid number of parameters for Math." + name + ", expected " + paramCount);
                }
            }

            args.forEach(function (param, index) {
                if (!(param.canNumber() || param.isVector()))
                    throw new Error("Parameter " + index + " has invalid type for Math." + name + ", expected 'number', but got " + param.getType());
            });
            var typeInfo = {
                type: returnType || args[0].isVector() ? TYPES.OBJECT : TYPES.NUMBER
            }
            args[0].isVector() && (typeInfo.kind = args[0].getKind());

            return typeInfo;
        }
    }

    var MathObject = {
        random: {
            type: TYPES.FUNCTION,
            evaluate: function (node, args) {
                if (args.length)
                    throw new Error("Math.random has no parameters.");
                return {
                    type: TYPES.NUMBER
                }
            },
            computeStaticValue: notStatic
        },
        abs: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args) {
                Tools.checkParamCount(result.node, "Math.abs", [1], args.length);
                var typeInfo = {};
                if(args[0].canNumber()) {
                    typeInfo.type = args[0].getType();
                }
                else if (args[0].isVector()) {
                    typeInfo.type = args[0].getType();
                    typeInfo.kind = args[0].getKind();
                }
                else {
                    Shade.throwError(result.node, "InvalidType for Math.abs");
                }
                // TODO: Static value
                return typeInfo;
            },
            computeStaticValue: evaluateStatic("abs")
        },


        // Non-standard methods
        clamp: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args) {
                Tools.checkParamCount(result.node, "Math.clamp", [3], args.length);

                if(args[1].canNumber() && args[2].canNumber()){
                    var typeInfo = {};
                    if(args[0].canNumber()) {
                        typeInfo.type = TYPES.NUMBER;
                    }
                    else if (args[0].isVector()) {
                        typeInfo.type = args[0].getType();
                        typeInfo.kind = args[0].getKind();
                    }
                    return typeInfo;
                }
                Shade.throwError(result.node, "Math.clamp not supported with argument types: " + args.map(function (arg) {
                    return arg.getTypeString();
                }).join(", "));
            },
            computeStaticValue: evaluateStatic("clamp")

        },
        smoothstep: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, ctx) {
                Tools.checkParamCount(result.node, "Math.smoothstep", [3], args.length);

                if (args.every(function (e) { return e.canNumber(); })) {
                    return { type: TYPES.NUMBER };
                }
                if (args.every(function (e) {
                    return e.isVector();
                })) {
                    if (!(args[0].equals(args[1]) && args[1].equals(args[2]))) {
                        Shade.throwError(result.node, "Math.smoothstep: All arguments have to have the same type: " + args.map(function (arg) {
                            return arg.getTypeString();
                        }).join(", "));
                    };
                    return  {
                        type: TYPES.OBJECT,
                        kind: args[0].getKind()
                    }

                };
                Shade.throwError(result.node, "Math.smoothstep not supported with argument types: " + args.map(function (arg) {
                    return arg.getTypeString();
                }).join(", "));
            },
            computeStaticValue: evaluateStatic("smoothstep")
        },
        step: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, ctx) {
                Tools.checkParamCount(result.node, "Shade.step", [2], args.length);

                if (Tools.allArgumentsCanNumber(args)) {
                    return { type: TYPES.NUMBER }
                }
                Shade.throwError(result.node, "Shade.step not supported with argument types: " + args.map(function (arg) {
                    return arg.getTypeString();
                }).join(", "));
            },
            computeStaticValue: evaluateStatic("step")
        },
        fract: {
            type: TYPES.FUNCTION,
            evaluate: Tools.Vec.anyVecArgumentEvaluate.bind(null, "fract"),
            computeStaticValue: evaluateStatic("fract")
        },
        mix: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, ctx) {
                Tools.checkParamCount(result.node, "Math.mix", [3], args.length);

                var cnt = Tools.Vec.checkAnyVecArgument(result.node, "Math.mix", args[0]);

                var typeInfo = {};
                Base.extend(typeInfo, Tools.Vec.getType(cnt));

                if (!args[1].equals(args[0]))
                    Shade.throwError(result.node, "Math.mix types of first two arguments do no match: got " + args[0].getTypeString() +
                        " and " + args[1].getTypeString());
                if (!args[2].canNumber())
                    Shade.throwError(result.node, "Math.mix third argument is not a number.");

                return typeInfo;
            },
            computeStaticValue: evaluateStatic("mix")
        },
        saturate: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, ctx) {
                Tools.checkParamCount(result.node, "Shade.saturate", [1], args.length);

                var typeInfo = {
                    type: TYPES.NUMBER
                }
                var arg = args[0];
                if (!arg.canNumber()) {
                    Shade.throwError(result.node, "Math.saturate not supported with argument type: " + arg.getTypeString());
                }
                return typeInfo;
            },
            computeStaticValue: evaluateStatic("saturate")
        }
    };

    var MathConstants = ["E", "PI", "LN2", "LOG2E", "LOG10E", "PI", "SQRT1_2", "SQRT2"];
    var OneParameterNumberMethods = ["acos", "asin", "atan", "cos", "exp", "log", "round", "sin", "sqrt", "tan", "ceil", "floor"];
    var OneParameterIntMethods = [];
    var TwoParameterNumberMethods = ["atan2", "pow"];
    var ArbitraryParameterNumberMethods = ["max", "min"];

    MathConstants.forEach(function (constant) {
        MathObject[constant] = { type: TYPES.NUMBER, staticValue: Math[constant] };
    });

    OneParameterNumberMethods.forEach(function (method) {
        MathObject[method] = { type: TYPES.FUNCTION, evaluate: evaluateMethod(method, 1), computeStaticValue: evaluateStatic(method) };
    });

    TwoParameterNumberMethods.forEach(function (method) {
        MathObject[method] = { type: TYPES.FUNCTION, evaluate: evaluateMethod(method, 2), computeStaticValue: evaluateStatic(method)  };
    });

    OneParameterIntMethods.forEach(function (method) {
        MathObject[method] = { type: TYPES.FUNCTION, evaluate: evaluateMethod(method, 1, TYPES.INT), computeStaticValue: evaluateStatic(method)  };
    });

    ArbitraryParameterNumberMethods.forEach(function (method) {
        MathObject[method] = { type: TYPES.FUNCTION, evaluate: evaluateMethod(method, -1), computeStaticValue: evaluateStatic(method)  };
    });

    Base.extend(ns, {
        id: "Math",
        object: {
            constructor: null,
            static: MathObject,
            staticValue: Math
        },
        instance: MathObject
    });


}(exports));

},{"../../../base/index.js":85,"../../../interfaces.js":111,"./tools.js":70}],66:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Base = require("../../../base/index.js"),
        Tools = require("./tools.js");

    var ShadeConstructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.COLOR_CLOSURE,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: function(result, args, context, objectReference, root) {
            if (args.length > 0)
                throw new Error("Shade.emission expects no parameters.");
            return {
                type: TYPES.OBJECT,
                kind: KINDS.COLOR_CLOSURE
            };
        }
    };

    var checkArgumentIsColor = function(node, args, position, name) {
        if(!args[position] || !args[position].canColor())
            Shade.throwError(node, "Argument "+ position + " of Shade." + name + " must evaluate to a color, found " + (args[position] ? args[position].getTypeString() : "undefined"));
    };

    var checkArgumentIsNormal = function(node, args, position, name) {
        if(!args[position] || !args[position].canNormal())
            Shade.throwError(node, "Argument "+ position + " of Shade." + name + " must evaluate to a normal, found " + (args[position] ? args[position].getTypeString() : "undefined"));
    };

    var ShadeObject = {
        emission: {
            type: TYPES.FUNCTION,
            evaluate: function(result, args, context, objectReference, root) {
                if (args.length > 0)
                    throw new Error("Shade.emission expects no parameters.");
                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        diffuse: {
            type: TYPES.FUNCTION,
            name: "diffuse",
            evaluate: function(result, args, context, objectReference, root) {
                checkArgumentIsColor(result.node, args, 0, this.name);
                checkArgumentIsNormal(result.node, args, 1, this.name);

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        phong: {
            type: TYPES.FUNCTION,
            name: "phong",
            evaluate: function(result, args, ctx) {
                // TODO: Check arguments based on interface description
                checkArgumentIsColor(result.node, args, 0, this.name);
                checkArgumentIsNormal(result.node, args, 1, this.name);

                if (args.length > 2) {
                    var shininess = args[2];
                    if(!shininess.canNumber()) {
                        throw new Error("Third argument (shininess) of Shade.phong must evaluate to a number. Found: " + shininess.str());
                    }
                }

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        cookTorrance: {
            type: TYPES.FUNCTION,
            name: "cookTorrance",
            evaluate: function(result, args, ctx) {
                // TODO: Check arguments based on interface description
                checkArgumentIsColor(result.node, args, 0, this.name);
                checkArgumentIsNormal(result.node, args, 1, this.name);

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        ward: {
            type: TYPES.FUNCTION,
            name: "ward",
            evaluate: function(result, args, ctx) {
                // TODO: Check arguments based on interface description
                checkArgumentIsColor(result.node, args, 0, this.name);
                checkArgumentIsNormal(result.node, args, 1, this.name);
                checkArgumentIsNormal(result.node, args, 2, this.name);

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        reflect: {
            type: TYPES.FUNCTION,
            name: "reflect",
            evaluate: function(result, args, ctx) {
                // TODO: Check arguments based on interface description
                checkArgumentIsNormal(result.node, args, 0, this.name);

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        refract: {
            type: TYPES.FUNCTION,
            name: "refract",
            evaluate: function(result, args, ctx) {
                // TODO: Check arguments based on interface description
                checkArgumentIsNormal(result.node, args, 0, this.name);

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        },
        scatter: {
            type: TYPES.FUNCTION,
            name: "scatter",
            evaluate: function(result, args, ctx) {
                // TODO: Check arguments based on interface description
                checkArgumentIsColor(result.node, args, 0, this.name);
                checkArgumentIsNormal(result.node, args, 1, this.name);

                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.COLOR_CLOSURE
                };
            }
        }

    };

    Base.extend(ns, {
        id: "Shade",
        kind: KINDS.COLOR_CLOSURE,
        object: {
            constructor: ShadeConstructor,
            static: null
        },
        instance: ShadeObject

    });

}(exports));

},{"../../../base/index.js":85,"../../../interfaces.js":111,"./tools.js":70}],67:[function(require,module,exports){
(function (ns) {

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;
        Base = require("../../../base/index.js"),
        Tools = require("./tools.js");


    var SpaceObject = {
        transformDirection: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, context, objectReference, root) {
                if (args.length != 2)
                    throw new Error("transformDirection expects 2 parameters.");
                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.FLOAT3
                };
            }
        },
        transformPoint: {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, context, objectReference, root) {
                if (args.length != 2)
                    throw new Error("transformPoint expects 2 parameters.");
                return {
                    type: TYPES.OBJECT,
                    kind: KINDS.FLOAT3
                };
            }
        },
        VIEW: { type: TYPES.NUMBER},
        WORLD: { type: TYPES.NUMBER}
    };

    Base.extend(ns, {
        id: "Space",
        object: {
            constructor: null,
            static: SpaceObject,
            staticValue: Math
        },
        instance: SpaceObject
    });


}(exports));

},{"../../../base/index.js":85,"../../../interfaces.js":111,"./tools.js":70}],68:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        Base = require("../../../base/index.js"),
        Annotations = require("../../../base/annotation.js"),
        Tools = require("./tools.js");

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        ANNO = Annotations.ANNO;


    /**
     * Derived parameters: These exist in the system for convenience,
     * but can be derived from other system parameters
     */
    var DerivedCanvasProperties = {
        normalizedCoords: {
            type: TYPES.OBJECT,
            kind: KINDS.FLOAT3,
            derived: true
        },
        height: {
            type: TYPES.INT,
            derived: true
        },
        width: {
            type: TYPES.INT,
            derived: true
        }

    };

    function allowNumberOrVector(name) {
        return function(result, args) {
           Tools.checkParamCount(result.node, name, [1], args.length);
                var arg = args[0];
                if (arg.canNumber()) {
                    return {
                        type: arg.getType()
                    }
                }
                if (arg.isVector()) {
                    return {
                        type: TYPES.OBJECT,
                        kind: arg.getKind()
                    }
                }
                Shade.throwError(result.node, "IllegalArgumentError: first argument of this." + name + " is of type: " + arg.getTypeString());
        }
    }


    var OptionalMethods = {
        fwidth: {
            type: TYPES.FUNCTION,
            evaluate: allowNumberOrVector("fwidth")
        },
        dx: {
            type: TYPES.FUNCTION,
            evaluate: allowNumberOrVector("dx")
        },
        dy: {
            type: TYPES.FUNCTION,
            evaluate: allowNumberOrVector("dy")
        }
    };

    ns.getThisTypeInfo = function(systemInfo) {
        systemInfo = systemInfo || { type: TYPES.OBJECT, kind: KINDS.ANY, info: {}};
        var thisAnnotation = ANNO({}, systemInfo);
        // Add those parameters that can be calculated from system inputs
        var objectInfo = thisAnnotation.getNodeInfo();
        if (!objectInfo) {
            objectInfo = {};
            thisAnnotation.setNodeInfo(objectInfo);
        }

        if(objectInfo.hasOwnProperty("coords")) {
            Base.extend(objectInfo, DerivedCanvasProperties);
        }
        for(var entry in OptionalMethods) {
            if(objectInfo.hasOwnProperty(entry)) {
                Base.extend(objectInfo[entry], OptionalMethods[entry])
            }
        }

        return thisAnnotation;
    }



}(exports));

},{"../../../base/annotation.js":80,"../../../base/index.js":85,"../../../interfaces.js":111,"./tools.js":70}],69:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var TextureConstructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.TEXTURE,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: function(result, args, ctx) {
            Shade.throwError(result.node, "Construction of Textures is not supported." );
        }
    };

    var TextureStaticObject = {
    };

    var TextureInstance = {
        width: {
            type: TYPES.INT
        },
        height: {
            type: TYPES.INT
        }
    };

    Tools.Vec.attachVecMethods(TextureInstance, "Texture", 4, 2, ['sample2D']);

    Tools.extend(ns, {
        id: "Texture",
        kind: KINDS.TEXTURE,
        object: {
            constructor: TextureConstructor,
            static: TextureStaticObject
        },
        instance: TextureInstance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],70:[function(require,module,exports){
(function(ns){
    var Base = require("../../../base/index.js");
    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        VecBase = require("../../../base/vec.js");

    var allArgumentsAreStatic = function (args) {
        return args.every(function (arg) {
            return arg.hasStaticValue()
        });
    }

    ns.allArgumentsCanNumber = function(args) {
        return args.every(function (arg) {
            return arg.canNumber();
        });
    }

    ns.checkParamCount = function(node, name, allowed, is) {
        if (allowed.indexOf(is) == -1) {
            Shade.throwError(node, "Invalid number of parameters for " + name + ", expected " + allowed.join(" or ") + ", found: " + is);
        }
    }

    ns.singleAccessor = function (name, obj, validArgCounts, staticValueFunction) {
        return {
            type: TYPES.FUNCTION,
            evaluate: function (result, args, ctx, callObject) {
                ns.checkParamCount(result.node, name, validArgCounts, args.length);
                var typeInfo =  args.length ? obj : { type: TYPES.NUMBER };

                if (staticValueFunction && callObject.hasStaticValue() && args.every(function(a) {return a.hasStaticValue(); })) {
                    typeInfo.staticValue = staticValueFunction(callObject.getStaticValue(), args);
                }
                return typeInfo;
            }
        }
    };

    ns.extend = Base.extend;

    var Vec = {
        TYPES: {
            1: { type: TYPES.NUMBER },
            2: { type: TYPES.OBJECT, kind: KINDS.FLOAT2 },
            3: { type: TYPES.OBJECT, kind: KINDS.FLOAT3 },
            4: { type: TYPES.OBJECT, kind: KINDS.FLOAT4 }
        },
        getType: function(destVector){
            return Vec.TYPES[destVector];
        },
        getStaticValue: function(methodName, result, args, ctx, callObject){
            if(callObject.hasStaticValue() && allArgumentsAreStatic(args)){
                var object = callObject.getStaticValue();
                var callArgs = args.map(function(a) {return a.getStaticValue(); });
                var method = object[methodName];
                if(method)
                    return method.apply(object, callArgs);
            }
        },
        checkAnyVecArgument: function(astNode, methodName, arg){
            var cnt;

            if(arg.canNumber()) cnt = 1;
            else if(arg.isOfKind(KINDS.FLOAT2)) cnt = 2;
            else if(arg.isOfKind(KINDS.FLOAT3)) cnt = 3;
            else if(arg.isOfKind(KINDS.FLOAT4)) cnt = 4;
            else Shade.throwError(astNode, "Invalid parameter for " + methodName + ", type '" +
                    arg.getTypeString() + "' is not supported");
            return cnt;
        },
        checkVecArguments: function(methodName, vecSize, withEmpty, argStart, result, args){
            withEmpty = (withEmpty || vecSize == 0);
            var allowed = [];
            for(var i = withEmpty ? 0 : 1; i <= vecSize; ++i) allowed.push(i + argStart);
            ns.checkParamCount(result.node, methodName, allowed, args.length);

            if(withEmpty && args.length - argStart == 0)
                return;

            if(args.length - argStart== 1 && args[0].canNumber())
                return;

            var idx = 0;
            for(var i = argStart; idx < vecSize && i < args.length; ++i){
                var arg= args[i], cnt;
                if(arg.canNumber()) cnt = 1;
                else if(arg.isOfKind(KINDS.FLOAT2)) cnt = 2;
                else if(arg.isOfKind(KINDS.FLOAT3)) cnt = 3;
                else if(arg.isOfKind(KINDS.FLOAT4)) cnt = 4;
                else if(arg.isOfKind(KINDS.MATRIX3)) cnt = 9;
                else if(arg.isOfKind(KINDS.MATRIX4)) cnt = 16;
                else Shade.throwError(result.node, "Invalid parameter for " + methodName + ", type '" + arg.getTypeString() + "' is not supported");
                idx += cnt;
            }

            if(idx < vecSize)
                Shade.throwError(result.node, "Invalid parameters for " + methodName + ", expected " + vecSize + " scalar values, got " + idx);
            else if(i < args.length){
                Shade.throwError(result.node, "Invalid parameters for " + methodName + ", too many parameters");
            }
        },

        vecEvaluate: function(objectName, methodName, destVecSize, srcVecSize, result, args, ctx, callObject){
            Vec.checkVecArguments(objectName + "." + methodName, srcVecSize, false, 0, result, args);

            var typeInfo = {};
            Base.extend(typeInfo, Vec.getType(destVecSize));

            return typeInfo;
        },
        anyVecArgumentEvaluate: function(methodName, result, args, ctx, callObject){
            ns.checkParamCount(result.node, methodName, [1], args.length);
            var arg = args[0];

            var typeInfo = {};
            var cnt = Vec.checkAnyVecArgument(result.node, methodName, arg);
            Base.extend(typeInfo, Vec.getType(cnt));

            return typeInfo;
        },

        optionalZeroEvaluate: function(objectName, methodName, destVecSize, zeroDestVecSize, srcVecSize, result, args, ctx, callObject) {
            var qualifiedName = objectName + "." + methodName;
            var typeInfo = {};

            if(args.length == 0){
                Base.extend(typeInfo, Vec.getType(zeroDestVecSize));
            }
            else{
                Vec.checkVecArguments(qualifiedName, srcVecSize, true, 0, result, args);
                Base.extend(typeInfo, Vec.getType(destVecSize));
            }

            return typeInfo;
        },

        swizzleEvaluate: function(objectName, vecSize, swizzle, withSetter, result, args, ctx, callObject) {
            if(withSetter){
                return Vec.optionalZeroEvaluate(objectName, swizzle, vecSize, swizzle.length, swizzle.length,
                    result, args, ctx, callObject);
            }
            else{
                return Vec.vecEvaluate(objectName, swizzle, swizzle.length, 0, result, args, ctx, callObject);
            }
        },
        swizzleOperatorEvaluate: function(objectName, vecSize, swizzle, operator, result, args, ctx, callObject) {
            return Vec.vecEvaluate(objectName, swizzle + operator, vecSize, swizzle.length, result, args, ctx, callObject);
        },
        getSwizzleEvaluate: function(objectName, vecSize, swizzle, withSetter){
            return  {
                type: TYPES.FUNCTION,
                evaluate: Vec.swizzleEvaluate.bind(null, objectName, vecSize, swizzle, withSetter),
                computeStaticValue: Vec.getStaticValue.bind(null, swizzle)
            }
        },
        getSwizzleOperatorEvaluate: function(objectName, vecSize, swizzle, operator){
            return  {
                type: TYPES.FUNCTION,
                evaluate: Vec.swizzleOperatorEvaluate.bind(null, objectName, vecSize, swizzle, operator),
                computeStaticValue: Vec.getStaticValue.bind(null, swizzle + operator)
            }
        },
        attachSwizzles: function (instance, objectName, vecCount){
            for(var s = 0; s < VecBase.swizzleSets.length; ++s){
                for(var count = 1; count <= 4; ++count){
                    var max = Math.pow(vecCount, count);
                     for(var i = 0; i < max; ++i){
                        var val = i;
                        var key = "";

                        var indices = [], withSetter = (count <= vecCount);
                        for(var  j = 0; j < count; ++j){
                            var idx = val % vecCount;
                            val = Math.floor(val / vecCount);
                            key+= VecBase.swizzleSets[s][idx];
                            if(indices[idx])
                                withSetter = false;
                            else
                                indices[idx] = true;
                        }
                        instance[key] = Vec.getSwizzleEvaluate(objectName, vecCount, key, withSetter);
                        if(withSetter){
                            for(var operator in VecBase.swizzleOperators){
                                instance[key + operator] = Vec.getSwizzleOperatorEvaluate(objectName, vecCount, key, operator);
                            }
                        }
                    }
                }
            }
        },
        attachVecMethods: function(instance, objectName, destVecSize, srcVecSize, methodNames){
            for(var i = 0; i < methodNames.length; ++i){
                    var methodName = methodNames[i];
                    instance[methodName] = {
                        type: TYPES.FUNCTION,
                        evaluate: Vec.vecEvaluate.bind(null, objectName, methodName, destVecSize, srcVecSize)
                    }
            }
        },

        getStaticValueFromConstructor: function(objectName, args){
            var argArray = [];
            var isStatic = true;
            args.forEach(function (param) {
                isStatic = isStatic && param.hasStaticValue();
                if (isStatic)
                    argArray.push(param.getStaticValue());
            });

            if (isStatic) {
                var v = new Shade[objectName]();
                Shade[objectName].apply(v, argArray);
                return v;
            }
            return undefined;
        },

        constructorEvaluate: function(objectName, vecSize, result, args, ctx) {
            Vec.checkVecArguments(objectName, vecSize, true, 0, result, args);
            return Vec.getType(vecSize);
        },
        constructorComputeStaticValue: function(objectName, result, args, ctx) {
            return Vec.getStaticValueFromConstructor(objectName, args);
        }

    };

    var Mat = {
        TYPES: {
            "Mat3": { type: { type: TYPES.OBJECT, kind: KINDS.MATRIX3 }, cols: 3, rows: 3 },
            "Mat4": { type: { type: TYPES.OBJECT, kind: KINDS.MATRIX4 }, cols: 4, rows: 4 }
        },
        getType: function(matName){
            return Mat.TYPES[matName].type;
        },
        getVecSize: function(matName){
            return Mat.TYPES[matName].cols * Mat.TYPES[matName].rows;
        },
        checkMatArguments: function(methodName, matName, withEmpty, result, args){
            if(args.length == 1 && (args[0].isOfKind(KINDS.MATRIX3) || args[0].isOfKind(KINDS.MATRIX4)))
                return;

            for(var i = 0; i < args.length; ++i){
                if(args[i].isOfKind(KINDS.MATRIX3) || args[i].isOfKind(KINDS.MATRIX4))
                    Shade.throwError(result.node, "Invalid parameter for " + methodName + ": Constructing Matrix from Matrix can only take one argument");
            }
            Vec.checkVecArguments(methodName, Mat.getVecSize(matName), withEmpty, 0, result, args);
        },

        matEvaluate: function(matName, methodName, result, args, ctx, callObject){
            Mat.checkMatArguments(matName + "." + methodName, matName, false, result, args);

            var typeInfo = {};
            Base.extend(typeInfo, Mat.getType(matName));

            return typeInfo;
        },

        matConstructorEvaluate: function(matName, result, args, ctx){
            Mat.checkMatArguments(matName, matName, true, result, args);
            return Vec.getConstructorTypeInfo(matName, Mat.getVecSize(matName), Mat.getType(matName), result, args);
        },

        attachMatMethods: function(instance, matName, methodNames){
            for(var i = 0; i < methodNames.length; ++i){
                var methodName = methodNames[i];
                instance[methodName] = {
                    type: TYPES.FUNCTION,
                    evaluate: Mat.matEvaluate.bind(null, matName, methodName)
                }
            }
        },
        colEvaluate: function(matName, result, args, ctx, callObject) {
            var qualifiedName = matName + ".col";
            var typeInfo = {};

            var cols = Mat.TYPES[matName].cols, rows = Mat.TYPES[matName].rows;

            if(args.length > 1){
                Vec.checkVecArguments(qualifiedName, rows, true, 1, result, args);
                Base.extend(typeInfo, Mat.getType(matName));
            }
            else{
                ns.checkParamCount(result.node, qualifiedName, [1], args.length);
                Base.extend(typeInfo, Vec.getType(rows));
            }
            if(!args[0].canNumber()){
                Shade.throwError(result.node, "Invalid parameter for " + qualifiedName + ", first parameter must be a number.");
            }

            // TODO: Vec.getStaticValue(typeInfo, "col", args, callObject);

            return typeInfo;
        }

    }

    ns.Vec = Vec;
    ns.Mat = Mat;
    ns.allArgumentsAreStatic = allArgumentsAreStatic;


}(exports));

},{"../../../base/index.js":85,"../../../base/vec.js":88,"../../../interfaces.js":111}],71:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var Vector2Constructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.FLOAT2,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: Tools.Vec.constructorEvaluate.bind(null, "Vec2", 2),
        computeStaticValue: Tools.Vec.constructorComputeStaticValue.bind(null, "Vec2")
    };

    var Vector2StaticObject = {
    };

    var Vector2Instance = {
        length: {
            type: TYPES.FUNCTION,
            evaluate: Tools.Vec.optionalZeroEvaluate.bind(null,"Vec2", "length", 2, 1, 1)
        }
    };
    Tools.Vec.attachSwizzles(Vector2Instance, "Vec2", 2);
    Tools.Vec.attachVecMethods(Vector2Instance, "Vec2", 2, 2, ['add', 'sub', 'mul', 'div', 'mod', 'reflect']);
    Tools.Vec.attachVecMethods(Vector2Instance, "Vec2", 1, 2, ['dot']);
    Tools.Vec.attachVecMethods(Vector2Instance, "Vec2", 2, 0, ['normalize', 'flip']);


    Tools.extend(ns, {
        id: "Vec2",
        kind: KINDS.FLOAT2,
        object: {
            constructor: Vector2Constructor,
            static: Vector2StaticObject
        },
        instance: Vector2Instance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],72:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var Vector3Constructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.FLOAT3,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: Tools.Vec.constructorEvaluate.bind(null, "Vec3", 3),
        computeStaticValue: Tools.Vec.constructorComputeStaticValue.bind(null, "Vec3")

    };

    var Vector3StaticObject = {
    };

    var Vector3Instance = {
        length: {
            type: TYPES.FUNCTION,
            evaluate: Tools.Vec.optionalZeroEvaluate.bind(null,"Vec3", "length", 3, 1, 1)
        }
    };
    Tools.Vec.attachSwizzles(Vector3Instance, "Vec3", 3);
    Tools.Vec.attachVecMethods(Vector3Instance, "Vec3", 3, 3, ['add', 'sub', 'mul', 'div', 'mod', 'reflect', "cross"]);
    Tools.Vec.attachVecMethods(Vector3Instance, "Vec3", 1, 3, ['dot']);
    Tools.Vec.attachVecMethods(Vector3Instance, "Vec3", 3, 0, ['normalize', 'flip']);

    Vector3Instance["refract"] = {
        type: TYPES.FUNCTION,
        evaluate: function (result, args, ctx) {
            if (args.length < 2)
                Shade.throwError(result.node, "Not enough parameters for refract.");

            var eta = args.pop();
            if (!eta || !eta.canNumber())
                Shade.throwError(result.node, "Invalid parameter for refract, expected a number got " + eta.getTypeString());

            Tools.Vec.checkVecArguments(Vector3Instance + "." + "refract", 3, false, 0, result, args);

            var typeInfo = {
                type: TYPES.OBJECT,
                kind: KINDS.FLOAT3
            };

            return typeInfo;
        }
    };

    Tools.extend(ns, {
        id: "Vec3",
        kind: KINDS.FLOAT3,
        object: {
            constructor: Vector3Constructor,
            static: Vector3StaticObject
        },
        instance: Vector3Instance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],73:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js"),
        TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS,
        Tools = require("./tools.js");

    var Vector4Constructor =  {
        type: TYPES.OBJECT,
        kind: KINDS.FLOAT4,
        /**
         * @param {Annotation} result
         * @param {Array.<Annotation>} args
         * @param {Context} ctx
         */
        evaluate: Tools.Vec.constructorEvaluate.bind(null, "Vec4", 4),
        computeStaticValue: Tools.Vec.constructorComputeStaticValue.bind(null, "Vec4")
    };

    var Vector4StaticObject = {
    };

    var Vector4Instance = {
        length: {
            type: TYPES.FUNCTION,
            evaluate: Tools.Vec.optionalZeroEvaluate.bind(null,"Vec4", "length", 4, 1, 1)
        }
    };
    Tools.Vec.attachSwizzles(Vector4Instance, "Vec4", 4);
    Tools.Vec.attachVecMethods(Vector4Instance, "Vec4", 4, 4, ['add', 'sub', 'mul', 'div', 'mod', 'reflect']);
    Tools.Vec.attachVecMethods(Vector4Instance, "Vec4", 1, 4, ['dot']);
    Tools.Vec.attachVecMethods(Vector4Instance, "Vec4", 4, 0, ['normalize', 'flip']);


    Tools.extend(ns, {
        id: "Vec4",
        kind: KINDS.FLOAT4,
        object: {
            constructor: Vector4Constructor,
            static: Vector4StaticObject
        },
        instance: Vector4Instance
    });


}(exports));

},{"../../../interfaces.js":111,"./tools.js":70}],74:[function(require,module,exports){
(function (ns) {

    // dependencies
    var assert = require('assert');
    var esgraph = require('esgraph');
    var worklist = require('analyses');
    var common = require("../../base/common.js");
    var Context = require("../../base/context.js");
    var Base = require("../../base/index.js");
    var codegen = require('escodegen');
    var annotateRight = require("./infer_expression.js").annotateRight;
    var InferenceScope = require("./registry/").InferenceScope;
    var System = require("./registry/system.js");
    var Annotations = require("./../../base/annotation.js");
    var walk = require('estraverse');
    var Tools = require("../settools.js");
    var Shade = require("../../interfaces.js");
    var walkes = require('walkes');
    var validator = require('../validator');
    var TypeInfo = require("../../base/typeinfo.js").TypeInfo;

    // shortcuts
    var Syntax = common.Syntax;
    var Map = common.Map;
    var Set = worklist.Set;
    var FunctionAnnotation = Annotations.FunctionAnnotation;
    var ANNO = Annotations.ANNO;








    function findConstantsFor(ast, names, constantVariables) {
        var result = new Set(), annotation, name, formerValue;
        constantVariables = constantVariables ? constantVariables.values() : [];

        walkes(ast, {
            AssignmentExpression: function(recurse) {


                if (this.left.type != Syntax.Identifier) {
                    Shade.throwError(ast, "Can't find constant for computed left expression");
                }
                name = this.left.name;
                if(names.has(name)) {
                    annotation = ANNO(this.right);
                    if(annotation.hasStaticValue()) {
                        switch(this.operator) {
                            case "=":
                                result.add({ name: name, constant: TypeInfo.copyStaticValue(annotation)});
                                break;
                            case "-=":
                            case "+=":
                            case "*=":
                            case "/=":
                                formerValue = constantVariables.filter(function(v){ return v.name == name; });
                                if(formerValue.length) {
                                    var c = formerValue[0].constant, v;
                                    switch(this.operator) {
                                        case "+=":
                                            v = c + TypeInfo.copyStaticValue(annotation);
                                            break;
                                        case "-=":
                                            v = c - TypeInfo.copyStaticValue(annotation);
                                            break;
                                        case "*=":
                                            v = c * TypeInfo.copyStaticValue(annotation);
                                            break;
                                        case "/=":
                                            v = c / TypeInfo.copyStaticValue(annotation);
                                            break;
                                    }
                                    result.add({ name: name, constant: v});
                                }
                                break;
                            default:
                                assert(!this.operator);
                        }

                    }
                }
                recurse(this.right);
            },

            VariableDeclarator: function(recurse) {
                name = this.id.name;
                if (this.init && names.has(name)) {
                    annotation = ANNO(this.init);
                    if(annotation.hasStaticValue()) {
                        result.add({ name: name, constant: TypeInfo.copyStaticValue(annotation)});
                    }
                }
                recurse(this.init);
            },

            UpdateExpression: function(recurse) {
                if(this.argument.type == Syntax.Identifier) {
                    name = this.argument.name;
                    annotation = ANNO(this);
                    if(annotation.hasStaticValue()) {
                        var value = TypeInfo.copyStaticValue(annotation);
                        if (!this.prefix) {
                            value = this.operator == "--" ? --value : ++value;
                        }
                        result.add({ name: name, constant: value});
                    }
                }
            }
        });

        return result;
    }



    /**
     *
     * @param ast
     * @param {AnalysisContext} context
     * @param {*} opt
     * @constructor
     */
    var TypeInference = function (ast, context, opt) {
        opt = opt || {};

        this.context = context;

        this.propagateConstants = opt.propagateConstants || false;
    };

    Base.extend(TypeInference.prototype, {

        /**
         * @param {*} ast
         * @param {*} opt
         * @returns {*}
         */
        inferBody: function (ast, opt) {
             var cfg = esgraph(ast, { omitExceptions: true }),
                 context = this.context,
                 propagateConstants = this.propagateConstants;

        //console.log("infer body", cfg)

        var result = worklist(cfg,
            /**
             * @param {Set} input
             * @this {FlowNode}
             * @returns {*}
             */
                function (input) {

                if (!this.astNode || this.type) // Start and end node do not influence the result
                    return input;

                //console.log("Analyze", codegen.generate(this.astNode), this.astNode.type);

                // Local
                if(propagateConstants) {
                    this.kill = this.kill || Tools.findVariableAssignments(this.astNode, true);
                }

                annotateRight(context, this.astNode, propagateConstants ? input : null );

                this.decl = this.decl || context.declareVariables(this.astNode);

                //context.computeConstants(this.astNode, input);

                if(!propagateConstants) {
                    return input;
                }



                var filteredInput = null, generate = null;
                if (this.kill.size) {
                    // Only if there's an assignment, we need to generate
                    generate = findConstantsFor(this.astNode, this.kill, propagateConstants ? input : null);
                    var that = this;
                    filteredInput = new Set(input.filter(function (elem) {
                            return !that.kill.some(function(tokill) { return elem.name == tokill });
                    }));
                }

                var result = Set.union(filteredInput || input, generate);
//                console.log("input:", input);
//                console.log("kill:", this.kill);
//                console.log("generate:", generate);
//                console.log("filteredInput:", filteredInput);
//                console.log("result:", result);
                return result;
            }
            , {
                direction: 'forward',
                merge: worklist.merge(function(a,b) {
                    if (!a && !b)
                        return null;
                    //console.log("Merge", a && a.values(), b && b.values())
                    var result = Set.intersect(a, b);
                    //console.log("Result", result && result.values())
                    return result;
                })
            });
        //Tools.printMap(result, cfg);
        return ast;
        }

    });




    /**
     *
     * @param ast
     * @param {AnalysisContext} context
     * @param opt
     * @returns {*}
     */
    var inferProgram = function (ast, context, opt) {
        opt = opt || {};
        //var globalScope = createGlobalScope(ast);
        //registerSystemInformation(globalScope, opt);

        var typeInference = new TypeInference(ast, context, opt);
        var result = typeInference.inferBody(ast, opt);


        return result;
    };

    ns.infer = inferProgram;

}(exports));

},{"../../base/common.js":82,"../../base/context.js":83,"../../base/index.js":85,"../../base/typeinfo.js":87,"../../interfaces.js":111,"../settools.js":58,"../validator":79,"./../../base/annotation.js":80,"./infer_expression.js":60,"./registry/":62,"./registry/system.js":68,"analyses":1,"assert":43,"escodegen":9,"esgraph":26,"estraverse":42,"walkes":49}],75:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var traverse = require('estraverse'),
        common = require("./../../base/common.js"),
        Shade = require("../../interfaces.js"),
        codegen = require('escodegen'),
        Set = require('analyses').Set,
        Tools = require('../../base/asttools.js');


    // Shortcuts
    var Syntax = traverse.Syntax, ANNO = common.ANNO;

    function toMap(uniformSet) {
        var result = {};
        uniformSet && uniformSet.forEach(function(entry) {
            result[entry.name] = {
                dependencies: entry.dependencies,
                costs: entry.costs
            };
        });
        return result;
    }

    var allowedMemberCalls = ["Math", "Shade"];

    ns.generateUniformExpressions = function (ast, input) {

        var uniformVariables = toMap(input);

        traverse.traverse(ast, {
            leave: function (node, parent) {
                var result = ANNO(node);
                result.clearUniformDependencies();

                switch (node.type) {

                    // New uniforms can come via the env object
                    case Syntax.MemberExpression:
                        var propertyAnnotation = ANNO(node.property);
                        if (propertyAnnotation.getSource() == Shade.SOURCES.UNIFORM) {
                            result.setUniformDependencies(node.property.name);
                            result.setUniformCosts(0);
                        }
                        break;

                    case Syntax.Identifier:
                        // Not a variable
                        if(!Tools.isVariableReference(node, parent))
                            return;

                        // Not a variable on the right side
                        if(parent.type == Syntax.AssignmentExpression && parent.left == node)
                            return;

                        if(uniformVariables.hasOwnProperty(node.name)) {
                            var propagatedUniform = uniformVariables[node.name];
                            result.setUniformDependencies(propagatedUniform.dependencies);
                            result.setUniformCosts(propagatedUniform.costs);
                        }

                        break;
                    case Syntax.BinaryExpression:
                         var left = ANNO(node.left),
                             right = ANNO(node.right);

                        if (left.canUniformExpression() && right.canUniformExpression()) {
                            result.setUniformDependencies(left.getUniformDependencies(), right.getUniformDependencies());
                            result.setUniformCosts(left.getUniformCosts() + right.getUniformCosts() + 2);
                        }
                        break;
                    case Syntax.UnaryExpression:
                        var argument = ANNO(node.argument);

                        if(argument.isUniformExpression()) {
                            result.setUniformDependencies(argument.getUniformDependencies());
                            result.setUniformCosts(argument.getUniformCosts() + 1);
                        }
                        break;
                    case Syntax.CallExpression:
                        if(node.callee.type == Syntax.MemberExpression) {
                            var object = node.callee.object;
                            var args = node.arguments.map(function(arg) { return ANNO(arg);});

                            if(object.name && ~allowedMemberCalls.indexOf(object.name)) {
                                var dependencies = mergeUniformDependencies(args);
                                if(dependencies) {
                                    result.setUniformDependencies(dependencies);
                                    var costs = args.reduce(function(prev, next) { return prev + next.getUniformCosts(); }, 1);
                                    result.setUniformCosts(costs)
                                }
                            } else {
                                // TODO: CleanCode: Merge with above as soon as all differences are clear
                                var objectAnno = ANNO(object);
                                if(objectAnno.isUniformExpression()) {
                                    var dependencies = mergeUniformDependencies(args);
                                    if (dependencies || args.length == 0) {
                                        result.setUniformDependencies(dependencies, objectAnno.getUniformDependencies());
                                        var costs = args.reduce(function(prev, next) { return prev + next.getUniformCosts(); }, 1);
                                        result.setUniformCosts(costs)
                                    }
                                }  else {
                                    // console.log("No exp:", Shade.toJavaScript(node))
                                }
                            }
                        }
                        break;
                    case Syntax.NewExpression:
                        if(node.callee.type == Syntax.Identifier) {
                            var args = node.arguments.map(function(arg) { return ANNO(arg);});
                            var dependencies = mergeUniformDependencies(args);
                            if(dependencies) {
                                result.setUniformDependencies(dependencies);
                                var costs = args.reduce(function(prev, next) { return prev + next.getUniformCosts(); }, 1);
                                result.setUniformCosts(costs);
                            }
                        }
                        break;

                }
            }
        });

        var result = new Set();
        switch (ast.type) {
            case Syntax.AssignmentExpression:
                var right = ANNO(ast.right);
                if (right.isUniformExpression()) {
                    result.add({ name: ast.left.name, dependencies: right.getUniformDependencies(), costs: right.getUniformCosts() });
                }
                break;
            case Syntax.VariableDeclaration:
                ast.declarations.forEach(function (declaration) {
                    if (declaration.init) {
                        var init = ANNO(declaration.init);
                        if (init.isUniformExpression()) {
                            result.add({ name: declaration.id.name, dependencies: init.getUniformDependencies(), costs: init.getUniformCosts() });
                        }
                    }
                });
                break;
        }
        return result;
    }
    
    
    function atLeastOneArgumentIsUniform(args) {
        var allUniformOrStatic = true,
            oneUniform = false;

        for(var i = 0; i < args.length && allUniformOrStatic; i++) {
            var thisUniform = args[i].isUniformExpression();
            allUniformOrStatic = allUniformOrStatic && (thisUniform || args[i].hasStaticValue());
            oneUniform = oneUniform || thisUniform;
        }
        return allUniformOrStatic && oneUniform;
    };

    function mergeUniformDependencies(args) {
        var uniformDependencies = null;

        if(atLeastOneArgumentIsUniform(args)) {
            uniformDependencies = []
            for(var i = 0; i< args.length;i++) {
                if (args[i].isUniformExpression())        {
                    uniformDependencies = uniformDependencies.concat(args[i].getUniformDependencies());
                }
            }
        }
        return uniformDependencies;
    };

}(exports));

},{"../../base/asttools.js":81,"../../interfaces.js":111,"./../../base/common.js":82,"analyses":1,"escodegen":9,"estraverse":42}],76:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var common = require("../../base/common.js");
    var esgraph = require('esgraph');
    var worklist = require('analyses');
    var evaluator = require('./evaluator.js');
    var transformer = require('./uniformTransformer.js');
    var Tools = require("../settools.js");
    var assert = require("assert");

    // Shortcuts
    var Set = worklist.Set,
        Syntax = common.Syntax;

    /**
     * @param root
     * @param opt
     * @constructor
     */
    function UniformAnalysis(root, opt) {
        this.root = root;
        this.opt = opt || {};
    }


    UniformAnalysis.prototype = {
        analyzeBody: function (body) {
            var cfg = esgraph(body, { omitExceptions: true });


            var result = worklist(cfg,
            /**
             * @param {Set} input
             * @this {FlowNode}
             * @returns {*}
             */
                function (input) {

                if (!this.astNode || this.type) // Start and end node do not influence the result
                    return input;

                var generate = evaluator.generateUniformExpressions(this.astNode, input);
                this.kill = this.kill || Tools.findVariableAssignments(this.astNode, true);

                var filteredInput = input;
                if (this.kill.size) {
                    var that = this;
                    filteredInput = new Set(input.filter(function (elem) {
                            return !that.kill.some(function(tokill) { return elem.name == tokill });
                    }));
                }

                var result = Set.union(filteredInput, generate);

//                console.log("input:", input);
//                console.log("kill:", this.kill);
//                console.log("generate:", generate);
//                console.log("filteredInput:", filteredInput);
//                //console.log("result:", result);
                return result;
                }, {
                direction: 'forward',
                merge: worklist.merge(function(a,b) {
                    if (!a && !b)
                        return null;
                    return Set.intersect(a, b);
                })
            });
            //Tools.printMap(result, cfg);

        },

        transform: function () {
            var result = transformer.transform(this.root, this.opt);
            return result;
        }
    };


    ns.extract = function (ast, opt) {

        assert(ast.type == Syntax.Program || ast.type == Syntax.BlockStatement);

        var analysis = new UniformAnalysis(ast, opt);

        // Propagate and analyze
        analysis.analyzeBody(ast.type == Syntax.Program ? ast.body : ast);

        // Transform
        return analysis.transform();
    };


}(exports));

},{"../../base/common.js":82,"../settools.js":58,"./evaluator.js":75,"./uniformTransformer.js":78,"analyses":1,"assert":43,"esgraph":26}],77:[function(require,module,exports){
(function (ns) {

    var walk = require('estraverse');
    var Syntax = walk.Syntax;
    var ANNO = require("../../base/annotation.js").ANNO;

    var interfaces = require("../../interfaces.js");
    var TYPES = interfaces.TYPES,
        KINDS = interfaces.OBJECT_KINDS;

    function getConstructor(kind){
        switch(kind){
            case KINDS.FLOAT2: return "Shade.Vec2"; break;
            case KINDS.FLOAT3: return "Shade.Vec3"; break;
            case KINDS.FLOAT4: return "Shade.Vec4"; break;
            case KINDS.MATRIX3: return "Shade.Mat3"; break;
            case KINDS.MATRIX4: return "Shade.Mat4"; break;
            default: throw "Unsupported object kind in uniform expression argument: " + kind;
        }
    }


    function isMathCall(node) {
        return (node.callee.type === Syntax.MemberExpression && node.callee.object.type === Syntax.Identifier && node.callee.object.name === "Math");
    }

    function isVecMathCall(node) {
        if(!isMathCall(node))
            return false;
        var firstArgument = ANNO(node.arguments[0]);
        return firstArgument.isVector();
    }

    var leaveVisitor = function (node, parent, variables, controller) {
        if (node.type == Syntax.MemberExpression) {
            var object = ANNO(node.object);
            if (node.object.type == Syntax.Identifier && object.isUniformExpression()) {
                if(variables.hasOwnProperty(node.object.name)) {
                //console.log("Found: " + node.object.name, variables[node.object.name]);
                    node.object = variables[node.object.name].code;
                }
            }
            if (object.isGlobal() && node.property.type == Syntax.Identifier) {
                var property = ANNO(node.property);

                if(property.isObject()){
                    // Is the accessed parameter is a vector or matrix , we have to
                    // wrap the typed array in the respective constructor
                    var constructor = getConstructor(property.getKind());
                    return {
                        type: Syntax.NewExpression,
                        callee: { type: Syntax.Identifier, name: constructor},
                        arguments:  [node]
                    }
                }
                else if((parent == node) || parent.type != Syntax.MemberExpression){
                    // Is the accessed parameter is a scalar value, we have to
                    // access the first entry of the input array
                    return {
                        type: Syntax.MemberExpression,
                        computed: true,
                        object: node,
                        property: {
                            type: Syntax.Literal,
                            value: 0
                        }
                    }
                }
            }
        }

        if (node.type == Syntax.CallExpression) {
            if (isVecMathCall(node)) {
                node.callee.object.name = "Math";
            }
        }


        if (node.type == Syntax.Identifier) {
            if (~[Syntax.MemberExpression, Syntax.FunctionDeclaration, Syntax.VariableDeclarator].indexOf(parent.type))
                return;

            if (parent.type == Syntax.NewExpression && parent.callee == node)
                return;

            // Not a variable on the right side
            if (parent.type == Syntax.AssignmentExpression && parent.left == node)
                return;

            if(variables.hasOwnProperty(node.name)) {
                //console.log("Found: " + node.name, this[node.name]);
                var code = variables[node.name].code;
                return code;
            }
        }

        if (node.type == Syntax.NewExpression) {
            if (node.callee.type == Syntax.Identifier) {
                var name = node.callee.name;
                switch(name) {
                    case "Vec2":
                    case "Vec3":
                    case "Vec4":
                        node.callee.name = "Shade." + name;
                        break;

                }
            }
        }

        if (node.type == Syntax.ReturnStatement) {
            var anno = ANNO(node.argument);
            if(anno.isObject()){
                node.argument = { type: Syntax.CallExpression,
                    callee: {
                        type: Syntax.MemberExpression,
                        object: node.argument,
                        property: {type: Syntax.Identifier,
                            name: "_toFloatArray"
                        }
                    },
                    arguments: []
                };
                return node;
            }
        }
        }

    ns.transformUniformSetter = function (ast, variables) {
        return walk.replace(ast, { leave: function(node, parent) {
            return leaveVisitor(node, parent, variables, this);
        }});
    };


}(exports));

},{"../../base/annotation.js":80,"../../interfaces.js":111,"estraverse":42}],78:[function(require,module,exports){
(function(ns){

    // Dependencies
    var traverse = require('estraverse'),
        common = require("./../../base/common.js"),
        codegen = require('escodegen'),
        setterGenerator = require('./uniformSetterTransformation.js');

    // Shortcuts
    var ANNO = common.ANNO,
        Syntax = traverse.Syntax;

    var UniformTransformer = function(opt){
        opt = opt || {};

        var counter = opt.uniformCounter || 1;
        this.getCounter = function() {
            return counter++;
        };
        this.uniformExpressions = {};
        this.activeUniformVariables = {};
    };

    UniformTransformer.prototype = {
        transform: function(ast) {
            var that = this;
            return traverse.replace(ast, {
                enter: function(node) {
                    var anno = ANNO(node);
                    if(anno.isUniformExpression() && shouldGenerateUniformExpression(node, anno)) {
                        return that.generateUniformExpression(node);
                    }
                    if (node.type == Syntax.AssignmentExpression || (node.type == Syntax.VariableDeclarator && node.init)) {
                        var right = ANNO(node.right || node.init);
                        var leftNode = node.left || node.id;
                        if (right.isUniformExpression() && leftNode.type == Syntax.Identifier) {
                            that.activeUniformVariables[leftNode.name] = {
                                code: setterGenerator.transformUniformSetter(node.right || node.init, that.activeUniformVariables),
                                dependencies: right.getUniformDependencies()
                            }
                        }
                    }
                }
            });
        },
        getUniformExpression: function(uexp) {
            for(var name in this.uniformExpressions) {
                var other = this.uniformExpressions[name];
                if(uexp.code == other.code && equalDependencies(uexp.dependencies, other.dependencies))
                    return name;
            }
            return "";
        },
        generateUniformExpression: function(node) {
            var anno = ANNO(node);
            var uexp = {
                code: codegen.generate(setterGenerator.transformUniformSetter(node, this.activeUniformVariables)),
                dependencies: anno.getUniformDependencies()

            };

            var name = this.getUniformExpression(uexp);
            if(!name) {
                name = "u" + this.getCounter();
                this.uniformExpressions[name] = uexp;
            }
            var result = {
                type: Syntax.MemberExpression,
                object: {
                    type: Syntax.Identifier,
                    name: "uexp"
                },
                property: {
                    type: Syntax.Identifier,
                    name: name
                }
            }

            ANNO(result).copy(anno);
            return result;
        }
    };

    function equalDependencies(a, b) {
        if(a.length != b.length)
            return false;
        a.forEach(function(elem) {
            if(b.indexOf(elem) == -1)
                return false;
        });
        return true;
    }

    function shouldGenerateUniformExpression(node, anno) {
        var costs = anno.getUniformCosts();
        return costs > 0;
    };

    var transform = ns.transform = function (ast, opt) {
        var transformer = new UniformTransformer(opt);
        var result = transformer.transform(ast);
        opt.uniformExpressions = transformer.uniformExpressions;
        return result;
    };

}(exports));

},{"./../../base/common.js":82,"./uniformSetterTransformation.js":77,"escodegen":9,"estraverse":42}],79:[function(require,module,exports){
(function (ns) {

    var common = require("./../base/common.js"),
        Shade = require("../interfaces.js"),
        estraverse = require('estraverse');

    // var codegen = require('escodegen');

    var Syntax = common.Syntax,
        TYPES = Shade.TYPES,
        ANNO = common.ANNO;

    var activeFunction = "";

    var leaveNode = function(node) {
        var annotation = ANNO(node), right;

        if(activeFunction == "shade" && !annotation.isValid()) {
            var errorInfo = annotation.getError();
            var error = new Error(errorInfo.message);
            error.loc = errorInfo.loc;
            throw error;
        }

        if(node.type == Syntax.VariableDeclarator) {
            if(node.init) {
                right = ANNO(node.init);
                annotation.copy(right);
            }

            if (annotation.getType() == TYPES.ANY || annotation.isNullOrUndefined()) {
                Shade.throwError(node, "No type could be calculated for ")
            }
        }
        if(node.type == Syntax.AssignmentExpression) {
            right = ANNO(node.right);
            annotation.copy(right);
            annotation.clearUniformDependencies();

            if (annotation.getType() == TYPES.ANY || annotation.isNullOrUndefined()) {
                Shade.throwError(node, "No type could be calculated for ")
            }
        } else if(node.type == Syntax.ExpressionStatement) {
            var exp = ANNO(node.expression);
            annotation.copy(exp);
        }


    };

    /**
     * Validates AST: Tests if the non-eliminated nodes
     * are all valid and have type information
     * @param {Object} ast
     * @returns Object
     */
    var validate = ns.validate = function (ast) {
        return estraverse.replace(ast, {
            leave: leaveNode,
            enter: function (node) {
                if (node.type == Syntax.FunctionDeclaration) {
                    activeFunction = node.id.name;
                }
            }
        });
    }


}(exports));

},{"../interfaces.js":111,"./../base/common.js":82,"estraverse":42}],80:[function(require,module,exports){
(function(ns){

    var Shade = require("../interfaces.js"),
        Syntax = require('estraverse').Syntax,
        Base = require("./index.js"),
        TypeInfo = require("./typeinfo.js").TypeInfo;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;


    /**
     * @param {object} node
     * @param {object} extra
     * @extends TypeInfo
     * @constructor
     */
    var Annotation = function (node, extra) {
        TypeInfo.call(this, node, extra);
    };

    Base.createClass(Annotation, TypeInfo, {

        setCall : function(call) {
            var extra = this.getExtra();
            extra.evaluate = call;
        },
        getCall : function() {
            return this.getExtra().evaluate;
        },
        clearCall: function() {
            var extra = this.getExtra();
            delete extra.evaluate;
        }

    });


    /**
     * @param {object} node
     * @param {object} extra
     * @extends Annotation
     * @constructor
     */
    var FunctionAnnotation = function (node, extra) {
        Annotation.call(this, node, extra);
        this.setType(TYPES.FUNCTION);
    };

    Base.createClass(FunctionAnnotation, Annotation, {
        getReturnInfo: function() {
            return this.getExtra().returnInfo;
        },
        setReturnInfo: function(info) {
            this.getExtra().returnInfo = info;
        },
        isUsed: function() {
            return !!this.getExtra().used;
        },
        setUsed: function(v) {
            this.getExtra().used = v;
        }
    });

    ns.Annotation = Annotation;
    ns.FunctionAnnotation = FunctionAnnotation;
    ns.ANNO = function(object, extra){return new Annotation(object, extra)};

}(exports));

},{"../interfaces.js":111,"./index.js":85,"./typeinfo.js":87,"estraverse":42}],81:[function(require,module,exports){
(function (ns) {

    var Syntax = require("./common.js").Syntax;


    var isVariableName = function (node, parent) {
        return node.type == Syntax.Identifier && !((parent.type == Syntax.MemberExpression && parent.property == node) || parent.type == Syntax.FunctionDeclaration || (parent.type == Syntax.NewExpression && parent.callee == node) ||  (parent.type == Syntax.CallExpression && parent.callee == node));
    };

    var isVariableReference = function (node, parent) {
        return isVariableName(node, parent) && parent.type != Syntax.VariableDeclarator;
    };

    ns.isVariableReference = isVariableReference;
    ns.isVariableName = isVariableName;

}(exports));

},{"./common.js":82}],82:[function(require,module,exports){
(function (ns) {

    var ANNO = require("../base/annotation.js").ANNO,
        estraverse = require('estraverse'),
        ErrorHandler = require("./errors.js");


    var Syntax = estraverse.Syntax;

    /**
     *
     * @param {object|Array.<object>} node
     * @param scope
     * @returns {TypeInfo|Array.<TypeInfo>}
     */
    ns.createTypeInfo = function (node, scope) {
        if(Array.isArray(node)) {
            return node.map(function (arg) {
                return scope.createTypeInfo(arg);
            });
        }
        var result = ANNO(node);
        if (node.type == Syntax.Identifier || node.type == Syntax.ThisExpression) {
            var name = node.type == Syntax.Identifier ? node.name : 'this';
            var binding = scope.getBindingByName(name);
            if (binding) {
                result.copy(binding);
                return binding;
            }
        }
        return result;
    };

    /**
     *
     * @param {object|Array.<object>} node
     * @param scope
     * @param {Array?} constants Additional array of constants
     * @param {boolean} check
     * @returns {TypeInfo|Array.<TypeInfo>}
     */
    ns.getTypeInfo = function getTypeInfo(node, scope, constants, check) {
        if(!node)
            return null;

        check = check == undefined ? false : check;

        if(Array.isArray(node)) {
            return node.map(function (arg) {
                return getTypeInfo(arg, scope, constants, check);
            });
        }
        var binding;
        if (node.type == Syntax.Identifier) {
            var name = node.name;

            if(name == 'undefined')
                return ANNO(node);

            binding = scope.getBindingByName(name);
            if(binding == undefined && check) {
                ANNO(node).setInvalid(ErrorHandler.generateErrorInformation(node, ErrorHandler.ERROR_TYPES.REFERENCE_ERROR, name, "is not defined"));
                return ANNO(node);
            }
            if(binding) {
                var result = ANNO(node, binding.getExtra());
                // A variable is dynamic per default. Only if it's listed in constant
                // we can assume a static value
                result.setDynamicValue();
                binding.setDynamicValue();
                if (constants && !binding.isNullOrUndefined()) {
                    var propagatedConstant = constants.filter(function (constant) {
                        return constant.name == name;
                    });

                    if (propagatedConstant.length) {
                        binding.setStaticValue(propagatedConstant[0].constant);
                        result.setStaticValue(propagatedConstant[0].constant);
                    }
                }
                return binding;

            }
        } else if (node.type == Syntax.ThisExpression) {
            binding = scope.getBindingByName('this');
        }
        return binding || ANNO(node);
    };



    ns.Syntax = Syntax;
    ns.VisitorOption = estraverse.VisitorOption;
    ns.Map = require('es6-map-shim').Map;

    ns.ANNO = ANNO;
    ns.getObjectReferenceFromNode = ns.getTypeInfo;


}(exports));

},{"../base/annotation.js":80,"./errors.js":84,"es6-map-shim":8,"estraverse":42}],83:[function(require,module,exports){
(function (module) {

    var Context = function (root, opt) {

        this.options = opt || {};

        /**
         * The root of the program to analyze
         * @type {*}
         */
        this.root = root;

        /**
         * To identify the main method of the shader
         * @type {*|string}
         */
        this.mainFunction = opt.mainFunction || "global.shade";


        /**
         * @type {Array.<Scope>}
         */
        this.scopeStack = opt.scope ? [opt.scope] : [  ];

        /**
         * Reserved keywords
         * @type {Array.<string>}
         */
        this.blockedNames = opt.blockedNames || [];

        /**
         * Used names
         * @type {Array.<string>}
         */
        this.usedNames = [];


        this.declaration = false;
    };

    Context.prototype = {
        getScope: function () {
            return this.scopeStack[this.scopeStack.length - 1];
        },
        pushScope: function (scope) {
            return this.scopeStack.push(scope);
        },
        popScope: function () {
            return this.scopeStack.pop();
        },
        inMainFunction: function() {
            return this.getScope().str() == this.mainFunction;
        },
        setInDeclaration: function(inDeclaration) {
            this.declaration = inDeclaration;
        },
        inDeclaration : function () {
            return this.declaration;
        },
        getSafeName: function(baseName) {
            var index = 0, searchName = baseName;
            while (this.blockedNames.indexOf(searchName) != -1) {
                searchName = baseName + index++;
            }
            return searchName;
        },
        getSafeUniqueName: function(baseName) {
            var index = 1, searchName = baseName;
            while (!(this.usedNames.indexOf(searchName) == -1 && this.blockedNames.indexOf(searchName) == -1)) {
                searchName = baseName + index++;
            }
            this.usedNames.push(searchName);
            return searchName;
        }

    };


    module.exports = Context;

}(module));

},{}],84:[function(require,module,exports){
(function(){

    // Dependencies
    var codegen = require('escodegen');

    var ErrorHandler = {};

        /**
     * @param node
     * @param {string} type
     * @param {...*} message
     * @returns {{message: string, loc: *}}
     */
    ErrorHandler.generateErrorInformation = function(node, type, message) {
        var args = Array.prototype.slice.call(arguments).splice(2),
            loc = node.loc,
            codeInfo = "";

        codeInfo += codegen.generate(node);
        if (loc && loc.start.line) {
            codeInfo += " (Line " + loc.start.line + ")";
        }
        message = args.length ? args.join(" ") + ": " : "";
        return { message: type + ": " + message + codeInfo, loc: loc};
    };

    ErrorHandler.ERROR_TYPES = {
        TYPE_ERROR: "TypeError",
        REFERENCE_ERROR: "ReferenceError",
        NAN_ERROR: "NotANumberError",
        SHADEJS_ERROR: "ShadeJSError"
    };

    module.exports = ErrorHandler;

}(module));

},{"escodegen":9}],85:[function(require,module,exports){
(function(ns){

    ns.extend = function(a, b) {
        for ( var prop in b) {
            var g = b.__lookupGetter__(prop), s = b.__lookupSetter__(prop);
            if (g||s) {
                if (g) {
                    a.__defineGetter__(prop, g);
                }
                if (s) {
                    a.__defineSetter__(prop, s);
                }
            } else {
                if (b[prop] === undefined) {
                    delete a[prop];
                } else if (prop !== "constructor" || a !== window) {
                    a[prop] = b[prop];
                }
            }
        }
        return a;
    };



    ns.deepExtend = function(destination, source) {
        for (var property in source) {
            var srcValue = source[property];
            var dstValue = destination[property];
            var copy;
            if (Array.isArray(srcValue)) {
                copy = dstValue || [];
                ns.deepExtend(copy, srcValue);
            } else if (typeof srcValue === "object" && srcValue !== null) {
                copy = dstValue || {};
                ns.deepExtend(copy, srcValue);
            } else {
                copy = srcValue;
            }
            destination[property] = copy;
        }
        return destination;
    };

    ns.shallowExtend = function(destination, source) {
        for (var property in source) {
            destination[property] = source[property];
        }
        return destination;
    };

    /**
     *
     * @param {Object} ctor Constructor
     * @param {Object} parent Parent class
     * @param {Object=} methods Methods to add to the class
     * @return {Object!}
     */
    ns.createClass = function(ctor, parent, methods) {
        methods = methods || {};
        if (parent) {
            /** @constructor */
            var F = function() {
            };
            F.prototype = parent.prototype;
            ctor.prototype = new F();
            ctor.prototype.constructor = ctor;
            ctor.superclass = parent.prototype;
        }
        for ( var m in methods) {
            ctor.prototype[m] = methods[m];
        }
        return ctor;
    };


}(exports))

},{}],86:[function(require,module,exports){
(function(ns){

    var Base = require("./index.js"),
        Shade = require("../interfaces.js"),
        TYPES = Shade.TYPES,
        Annotation = require("./annotation.js").Annotation,
        TypeInfo = require("./typeinfo.js").TypeInfo,
        Syntax = require('estraverse').Syntax,
        ErrorHandler = require("./errors.js");


    /**
     *
     * @param binding
     * @extends TypeInfo
     * @constructor
     */
    var Binding = function(binding, registry) {
        TypeInfo.call(this, binding);
        if(this.node.ref) {
            if (!registry[this.node.ref])
                throw Error("No object has been registered for: " + this.node.ref);
            this.globalObject = registry[this.node.ref].object;
            if (this.globalObject) {
                this.setType(TYPES.OBJECT);
            }
        }
    };


    Base.createClass(Binding, TypeInfo, {
        hasConstructor: function() {
            return !!this.getConstructor();
        },
        getConstructor: function() {
            return this.globalObject && this.globalObject.constructor;
        },
        isInitialized: function() {
            return this.node.initialized;
        },
        setInitialized: function(v) {
            this.node.initialized = v;
        },
        hasStaticValue: function() {
            return this.globalObject ? true : TypeInfo.prototype.hasStaticValue.call(this);
        },
        getStaticValue : function() {
            if (!this.hasStaticValue()) {
                throw new Error("Node has no static value: " + this.node);
            }
           return this.globalObject ? this.globalObject.staticValue : TypeInfo.prototype.getStaticValue.call(this);
        },
        isGlobal: function() {
            return this.node.info && this.node.info._global || TypeInfo.prototype.isGlobal.call(this);
        },
        getType: function() {
            return this.globalObject? TYPES.OBJECT : TypeInfo.prototype.getType.call(this);
        },
        getStaticProperties: function() {
            if (this.globalObject)
                return this.globalObject.static;
            return null;
        },
        getInfoForSignature: function(signature) {
            var extra = this.getExtra();
            if(!extra.signatures)
                return null;
            return extra.signatures[signature];
        },
        setInfoForSignature: function(signature, info) {
            var extra = this.getExtra();
            if(!extra.signatures)
                extra.signatures = {};
            return extra.signatures[signature] = info;
        }


    })


    /**
     * @param {Scope|null} parent
     * @param opt
     * @constructor
     */
    var Scope = function(node, parent, opt) {
        opt = opt || {};

        /** @type (Scope|null) */
        this.parent = parent || opt.parent || null;
        this.registry = opt.registry || (parent ? parent.registery : {});

        this.scope = node.scope = node.scope || {};

        /** @type {Object.<string, {initialized: boolean, annotation: Annotation}>} */
        this.scope.bindings = this.scope.bindings || {};
        if(opt.bindings) {
            Base.extend(this.scope.bindings, opt.bindings);
        }

        this.scope.name = opt.name || node.name || "<anonymous>";

    };

    Base.extend(Scope.prototype, {
        setRegistry: function(registry) {
            this.registry = registry;
        },
        getName: function() {
            return this.scope.name;
        },
        getRootContext: function() {
            if (this.parent)
                return this.parent.getRootContext();
            return this;
        },

        getBindings: function() {
            return this.scope.bindings;
        },

        updateReturnInfo: function(annotation) {
            this.scope.returnInfo = annotation.getExtra();
        },
        getReturnInfo: function() {
            return this.scope.returnInfo || { type: TYPES.UNDEFINED };
        },

        /**
         * @param {string} name
         * @returns {*}
         */
        getBindingByName: function(name) {
            var bindings = this.getBindings();
            var binding = bindings[name];
            if(binding !== undefined)
                return new Binding(binding, this.registry);
            if (this.parent)
                return this.parent.getBindingByName(name);
            return undefined;
        },

        /**
         * @param {string} name
         * @returns {Scope|null}
         */
        getContextForName: function(name) {
            var bindings = this.getBindings();
            if(bindings[name] !== undefined)
                return this;
            if (this.parent)
                return this.parent.getContextForName(name);
            return null;
        },

        getVariableIdentifier: function(name) {
            var scope = this.getContextForName(name);
            if(!scope)
                return null;
            return scope.str() + "." + name;
        },

        declareVariable: function(name, fail, position) {
            var bindings = this.getBindings();
            fail = (fail == undefined) ? true : fail;
            if (bindings[name]) {
                if (fail) {
                    throw new Error(name + " was already declared in this scope.")
                } else {
                    return false;
                }
            }

            var init = {
                initialized : false,
                initPosition: position,
                extra: {
                    type: TYPES.UNDEFINED
                }
            };
            bindings[name] = init;
            return true;
        },

        /**
         *
         * @param {string} name
         * @param {TypeInfo} typeInfo
         */
        updateTypeInfo: function (name, typeInfo, node) {
            var v = this.getBindingByName(name);
            if (!v) {
                if(node) {
                    typeInfo.setInvalid(ErrorHandler.generateErrorInformation(node, ErrorHandler.ERROR_TYPES.REFERENCE_ERROR, name, "is not defined"));
                    return;
                }
                throw new Error("Reference error: " + name + " is not defined.")
            }
            if (v.isInitialized() && v.getType() !== typeInfo.getType()) {
                 if(node) {
                    typeInfo.setInvalid(ErrorHandler.generateErrorInformation(node, ErrorHandler.ERROR_TYPES.SHADEJS_ERROR, name, "may not change it's type"));
                    return;
                }
                throw new Error("Variable may not change it's type: " + name);
            }
            if (!v.isInitialized()) {
                // Annotate the declaration, if one is given
                if(v.node.initPosition)
                    v.node.initPosition.copy(typeInfo);
            }

            v.copy(typeInfo);
            v.setDynamicValue();
            v.setInitialized(!typeInfo.isUndefined());
        },

        registerObject: function(name, obj) {
            this.registry[obj.id] = obj;
            var bindings = this.getBindings();
            bindings[name] = {
                extra: {
                    type: TYPES.OBJECT
                },
                ref: obj.id
            };
        },

        declareParameters: function(params) {
            var bindings = this.getBindings();
            for(var i = 0; i < params.length; i++) {
                var parameter = params[i];
                var annotation = new Annotation(parameter);

                var node = { extra: { type: TYPES.UNDEFINED }};
                var binding = new TypeInfo(node);
                binding.copy(annotation);
                bindings[parameter.name] = node;
            }
        },

        str: function() {
            var ctx = this;
            var names = [];
            while(ctx) {
                names.unshift(ctx.getName());
                ctx = ctx.parent;
            }
            return names.join(".");
        },

        getAllBindings: function() {
            var result = Object.keys(this.getBindings());
            if (this.parent) {
                var parentBindings = this.parent.getAllBindings();
                for(var i = 0; i < parentBindings.length; i++) {
                    if (result.indexOf(parentBindings[i]) !== -1) {
                        result.push(parentBindings[i]);
                    }
                }
            }
            return result;
        },

        /**
         *
         * @param node
         * @returns {TypeInfo}
         */
        createTypeInfo: function (node) {
            var result = new Annotation(node);
            if (node.type == Syntax.Identifier) {
                var name = node.name;
                var binding = this.getBindingByName(name);
                if (binding) {
                    result.copy(binding);
                    return binding;
                }
            }
            return result;
        },

        getObjectInfoFor: function(obj) {
            if (!obj.isObject())
                return null;

            // There are three ways to get the properties of an object

            // 1. Object is static and has registered it's properties via reference
            var staticProperties = obj.getStaticProperties();
            if (staticProperties)
                return staticProperties;

            // 1: Object is generic (any), then it carries it's information itself
            if (obj.isOfKind(Shade.OBJECT_KINDS.ANY)) {
                return obj.getNodeInfo();
            }


            // 3. Last chance: The object is an instance of a registered type,
            // then we get the information from it's kind
            return this.registry && this.registry.getInstanceForKind(obj.getKind()) || null;
        }

    });


    ns.exports = Scope;




}(module));

},{"../interfaces.js":111,"./annotation.js":80,"./errors.js":84,"./index.js":85,"./typeinfo.js":87,"estraverse":42}],87:[function(require,module,exports){
(function(ns){

    var Shade = require("../interfaces.js"),
        Syntax = require('estraverse').Syntax,
        Base = require("./index.js"),
        Set = require('analyses').Set;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;


    /**
     * @param {*} node Carrier object for the type info, only node.extra gets polluted
     * @param {Object?} extra
     * @constructor
     */
    var TypeInfo = function (node, extra) {
        this.node = node;
        this.node.extra = this.node.extra || {};
        if (extra) {
            Base.shallowExtend(this.node.extra, extra);
        }
    }

    TypeInfo.createForContext = function(node, ctx) {
        var result = new TypeInfo(node);
        if (result.getType() !== TYPES.ANY) {
            return result;
        }

        if (node.type == Syntax.Identifier) {
            var name = node.name;
            var variable = ctx.getBindingByName(name);
            if (variable) {
                result.copy(variable);
            }
        }
        return result;
    }

       /**
     * @param {TypeInfo} typeInfo
     * @param {Object?} value
     */
    TypeInfo.copyStaticValue = function(typeInfo, value) {
        value = value || typeInfo.getStaticValue();
        // We don't have to copy primitive types
        if(!typeInfo.isObject())
            return value;
        switch(typeInfo.getKind()) {
            case KINDS.FLOAT2: return new Shade.Vec2(value);
            case KINDS.FLOAT3: return new Shade.Vec3(value);
            case KINDS.FLOAT4: return new Shade.Vec4(value);
            case KINDS.MATRIX3: return new Shade.Mat3(value);
            case KINDS.MATRIX4: return new Shade.Mat4(value);
            default: throw new Error("Can't copy static value of kind: " + typeInfo.getKind());
        }
    }

    TypeInfo.prototype = {
        getExtra: function () {
            return this.node.extra;
        },
        getType: function () {
            var extra = this.getExtra();
            if (extra.type != undefined)
                return extra.type;
            return TYPES.ANY;
        },

        setKind: function (kind) {
            var extra = this.getExtra();
            extra.kind = kind;
        },

        getKind: function () {
            if (!this.isObject())
                return null;
            return this.getExtra().kind || KINDS.ANY;
        },

        getUserData: function () {
            var extra = this.getExtra();
            if(!extra.userData) extra.userData = {};
            return extra.userData;
        },

        getArrayElementType: function () {
            if(!this.isArray())
                throw new Error("Called getArrayElementType on " + this.getType());
            return this.getExtra().elements;
        },

        isOfKind: function(kind) {
            if (!this.isObject()) {
                return false;
            }
            return this.getKind() == kind;
        },

        /**
         * @param {string} type
         * @param {string?} kind
         */
        setType: function (type, kind) {
            var extra = this.getExtra();
            extra.type = type;
            if (kind)
                this.setKind(kind);
            if(this.isValid())
                this.clearError();
        },

        setInvalid: function(message) {
            this.setType(TYPES.INVALID);
            if(message)
                this.setError(message);
        },

        isOfType: function (type) {
            return this.getType() == type;
        },

        equals: function (other) {
            return this.getType() == other.getType() && this.getKind() == other.getKind();
        },

        isInt: function () {
            return this.isOfType(TYPES.INT);
        },
        isNumber: function () {
            return this.isOfType(TYPES.NUMBER);
        },
        isValid: function () {
            return !this.isOfType(TYPES.INVALID);
        },
        isNullOrUndefined: function () {
            return this.isNull() || this.isUndefined();
        },
        isNull: function () {
            return this.isOfType(TYPES.NULL);
        },
        isUndefined: function () {
            return this.isOfType(TYPES.UNDEFINED);
        },
        isBool: function () {
            return this.isOfType(TYPES.BOOLEAN);
        },
        isString: function () {
            return this.isOfType(TYPES.STRING);
        },
        isArray: function () {
            return this.isOfType(TYPES.ARRAY);
        },
        isFunction: function () {
            return this.isOfType(TYPES.FUNCTION);
        },
        isObject: function () {
            return this.isOfType(TYPES.OBJECT);
        },
        isVector: function () {
            return this.isObject() && this.isOfKind(KINDS.FLOAT2) || this.isOfKind(KINDS.FLOAT3) || this.isOfKind(KINDS.FLOAT4);
        },
        isGlobal: function() {
            return !!this.getExtra().global;
        },
        setGlobal: function (global) {
            var extra = this.getExtra();
            extra.global = global;
        },
        canNumber: function () {
            return this.isNumber() || this.isInt() || this.isBool();
        },
        canInt: function () {
            return this.isInt() || this.isBool();
        },
        canObject: function () {
            return this.isObject() || this.isArray() || this.isFunction();
        },
        setCommonType: function(a,b) {
            if(a.equals(b)) {
                this.copy(a);
                return true;
            }
            if(a.canNumber() && b.canNumber()) {
                this.setType(TYPES.NUMBER)
                return true;
            }
            return false;
        },
        hasStaticValue : function() {
            var extra = this.getExtra();
            if (this.isNullOrUndefined())
                return true;
            return extra.hasOwnProperty("staticValue");
        },
        setStaticValue : function(v) {
            var extra = this.getExtra();
            if (this.isNullOrUndefined())
                throw new Error("Null and undefined have predefined values.");
            extra.staticValue = v;
        },
        canUniformExpression: function() {
            return this.hasStaticValue() || this.isUniformExpression();
        },

        isUniformExpression: function() {
            var extra = this.getExtra();
            return extra.hasOwnProperty("uniformDependencies")
        },
        setUniformDependencies: function() {
            var extra = this.getExtra();
            var dependencies = new Set();
            var args = Array.prototype.slice.call(arguments);
            args.forEach(function(arg) {
               if(Array.isArray(arg))
                   dependencies = Set.union(dependencies, arg);
                else
                   dependencies.add(arg);
            });
            extra.uniformDependencies = dependencies.values();
        },
        getUniformDependencies: function() {
            var extra = this.getExtra();
            return extra.uniformDependencies || [];
        },
        getUniformCosts: function() {
            var extra = this.getExtra();
            return extra.uniformCosts | 0;
        },
        setUniformCosts: function(costs) {
            var extra = this.getExtra();
            extra.uniformCosts = costs;
        },
        clearUniformDependencies: function() {
            var extra = this.getExtra();
            delete extra.uniformDependencies;
        },
        getStaticValue : function() {
            if (!this.hasStaticValue()) {
                throw new Error("Node has no static value: " + this.node);
            }
            if (this.isNull())
                return null;
            if (this.isUndefined())
                return undefined;
            return this.getExtra().staticValue;
        },
        setDynamicValue : function() {
            delete this.getExtra().staticValue;
        },
        setCall : function(call) {
            var extra = this.getExtra();
            extra.evaluate = call;
        },
        getCall : function() {
            return this.getExtra().evaluate;
        },
        clearCall: function() {
            var extra = this.getExtra();
            delete extra.evaluate;
        },
        copy: function(other) {
            this.setFromExtra(other.getExtra());
        },
        str: function() {
            var extra = this.getExtra();
            return JSON.stringify(extra, null, 1);
        },
        canNormal: function() {
            return this.isObject() && (this.isOfKind(KINDS.NORMAL) || this.isOfKind(KINDS.FLOAT3));
        },
        canColor: function() {
            return this.isObject() && (this.isOfKind(KINDS.FLOAT4) || this.isOfKind(KINDS.FLOAT3));
        },
        hasError : function() {
            return this.getError() != null;
        },
        getError : function() {
            var extra = this.getExtra();
            return extra.error;
        },
        setError : function(err) {
            var extra = this.getExtra();
            extra.error = err;
        },
        clearError : function() {
            var extra = this.getExtra();
            extra.error = null;
        },
        setFromExtra: function(extra){
            Base.shallowExtend(this.node.extra, extra);
            // Set static object extra: This might be an object
            if (extra.staticValue != undefined) {
                this.setStaticValue(TypeInfo.copyStaticValue(this, extra.staticValue));
            }
        },
        getNodeInfo: function() {
            if (this.isObject())
                return this.getExtra().info;
        },
        setNodeInfo: function(info) {
            if (!this.isObject())
                throw new Error("Only objects may have a node info");
            this.getExtra().info = info;
        },
        getTypeString: function() {
            if (this.isObject()) {
                return this.isOfKind(KINDS.ANY) ? "Object" : ("Object #<" + this.getKind() + ">");
            }
            return this.getType();
        },
        /**
         * Get the internal type as JavaScript type
         * @returns {string}
         */
        getJavaScriptTypeString: function() {
            //noinspection FallthroughInSwitchStatementJS
            switch (this.getType()) {
                case TYPES.INT:
                case TYPES.FLOAT:
                case TYPES.NUMBER:
                    return "number";
                case TYPES.OBJECT:
                case TYPES.ARRAY:
                    return "object";
                case TYPES.STRING:
                    return "string";
                case TYPES.UNDEFINED:
                    return "undefined";
                default:
                    // TODO: For debug we use this now, should throw an exception
                    return "?" + this.getType();
            }
        },
        setSource: function(source) {
            var extra = this.getExtra();
            extra.source = source;
        },
        getSource: function() {
            return this.getExtra().source;
        },
        getStaticProperties: function() {
            // Only bound object have static properties (Math, Shade etc)
            return null;
        },
        isDerived: function() {
            return this.getExtra().derived == true;
        },
        getStaticTruthValue: function() {
            // !!undefined == false;
            if (this.isNullOrUndefined())
                return false;
            // !!{} == true
            if (this.canObject())
                return true;
            // In all other cases, it depends on the value,
            // thus we can only evaluate this for static objects
            if (this.hasStaticValue()) {
                return !!this.getStaticValue();
            }
            return undefined;
        },
        setSemantic: function(sem) {
            this.getExtra().semantic = sem;
        },
        getSemantic: function(sem) {
            return this.getExtra().semantic;
        }

    }




    ns.TypeInfo = TypeInfo;

}(exports));

},{"../interfaces.js":111,"./index.js":85,"analyses":1,"estraverse":42}],88:[function(require,module,exports){
(function(ns){

    ns.swizzleToIndex = function(swizzleKey){
        switch(swizzleKey){
            case 'x':case 'r' :case 's': return 0;
            case 'y':case 'g' :case 't': return 1;
            case 'z':case 'b' :case 'p': return 2;
            case 'w':case 'a' :case 'q': return 3;
        }
        throw new Error("Unknown swizzle key: '" + swizzleKey + "'");
    };
    ns.indexToSwizzle = function(index){
        switch(index){
            case 0: return 'x';
            case 1: return 'y';
            case 2: return 'z';
            case 3: return 'w';
        }
        throw new Error("Unknown swizzle index: '" + index + "'");
    };
    ns.swizzleSets = [
        ['x', 'y', 'z', 'w'],
        ['r', 'g', 'b', 'a'],
        ['s', 't', 'p', 'q']
    ];
    ns.swizzleOperators = {
        'Add' : '+',
        'Sub' : '-',
        'Mul' : '*',
        'Div' : '/'
    }


}(exports))

},{}],89:[function(require,module,exports){
(function(ns){

    var OneParameterNumberMethods = ["acos", "asin", "atan", "cos", "exp", "log", "round", "sin", "sqrt", "tan", "ceil", "floor"];

    function oneParameterFunction(name) {

        var func = Math[name];

        return function(vec) {
            var length = vec.length,
                result = new Float32Array(length);
            while(length--) {
                result[length] = func(vec[length]);
            }
            return result;
        }
    }

    var VecMath = {
        mix : function(x,y,a) {
            var length = x.length,
                result = new Float32Array(length),
                oneMinusA;

            if (Array.isArray(a) && a.length >= length) {
                while(length--) {
                    var a = a[length];
                    result[length] = x[length] * (1 - a) + y[length] * a;
                }
            } else {
                oneMinusA = 1 - a;
                while(length--) {
                    result[length] = x[length] * oneMinusA + y[length] * a;
                }
            }
            return result;

        },
        step : function(edge, x) {
            var length = edge.length,
                result = new Float32Array(length);

            while(length--) {
                var e = edge[length];
                var x0 = x[length];
                result[length] = (x0 <= e) ? 0 : 1;
            }
            return result;
        },
        smoothstep : function(edge0, edge1, x) {
            var length = edge0.length,
                result = new Float32Array(length);

            while(length--) {
                var e0 = edge0[length];
                var e1 = edge1[length];
                var x0 = x[length];
                var t = Math.clamp((x0 - e0) / (e1 - e0), 0.0, 1.0);
                result[length] = t * t * (3.0 - 2.0 * t);
            }
            return result;
        }
    };

    OneParameterNumberMethods.forEach(function(name) {
        VecMath[name] = oneParameterFunction(name);
    });

    ns.VecMath = VecMath;


}(exports));

},{}],90:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var common = require("../../base/common.js");
    var Shade = require("../../interfaces.js");

    // Shortcuts
    var Syntax = common.Syntax;

    function generateFloat(value) {
        if (isNaN(value))
            throw Error("Internal: Expression generated NaN!");
        var result = '' + value;
        if (result.indexOf(".") == -1 && result.indexOf("e") == -1) {
            result += ".0";
        }
        return result;
    }

    /**
     *
     * @param controller
     * @param {object?} options
     * @constructor
     */
    var ExpressionHandler = function (controller, options) {
        this.controller = controller;
        this.controller.generateFloat = this.controller.generateFloat || generateFloat;
        this.options = options || {};
    };

    ExpressionHandler.prototype = {
        binary: function (node) {
            var result = this.expression(node);
            //noinspection FallthroughInSwitchStatementJS
            switch (node.type) {
                case Syntax.BinaryExpression:
                case Syntax.LogicalExpression:
                case Syntax.AssignmentExpression:
                case Syntax.ConditionalExpression:
                    result = "( " + result + " )";
                    break;
            }
            return result;
        },
        arguments: function (container) {
            var result = "(";
            container.forEach(function (arg, index) {
                result += this.expression(arg);
                if (index < container.length - 1) {
                    result += ", ";
                }
            }, this);
            return result + ")";
        },
        literal: function (extra, alternative) {
            var extra = extra || {},
                value = extra.staticValue !== undefined ? extra.staticValue : alternative;

            if (extra.type == Shade.TYPES.NUMBER)
                return this.controller.generateFloat(value); else
                return value;
        },
        expression: function (node) {
            if (!node) return "";

            var result = "";

            //noinspection FallthroughInSwitchStatementJS
            switch (node.type) {
                case Syntax.NewExpression:
                    result = this.controller.type(node.extra, { constructor: true });
                    result += this.arguments(node.arguments);
                    break;

                case Syntax.Literal:
                    result = this.literal(node.extra, node.value);
                    break;

                case Syntax.Identifier:
                    result = node.name;
                    break;

                case Syntax.AssignmentExpression:
                case Syntax.BinaryExpression:
                case Syntax.LogicalExpression:
                    result += this.binary(node.left);
                    result += " " + node.operator + " ";
                    result += this.binary(node.right);
                    break;
                case Syntax.UnaryExpression:
                    result = node.operator;
                    result += this.binary(node.argument);
                    break;

                case Syntax.CallExpression:
                    result = this.expression(node.callee);
                    result += this.arguments(node.arguments);
                    break;

                case Syntax.MemberExpression:
                    result = this.binary(node.object);
                    result += node.computed ? "[" : ".";
                    result += this.expression(node.property);
                    node.computed && (result += "]");
                    break;

                case Syntax.ConditionalExpression:
                    result = this.expression(node.test);
                    result += " ? ";
                    result += this.expression(node.consequent);
                    result += " : ";
                    result += this.expression(node.alternate);
                    break;

                case Syntax.UpdateExpression:
                    result = "";
                    if (node.isPrefix) {
                        result += node.operator;
                    }
                    result += this.expression(node.argument);
                    if (!node.isPrefix) {
                        result += node.operator;
                    }
                    break;
                case Syntax.ExpressionStatement:
                    result = this.expression(node.expression);
                    break;
                default:
                    result = "<unhandled: " + node.type + ">"
            }
            return result;
        },
        statement: function (node) {
            var result = "unhandled statement";
            switch (node.type) {
                case Syntax.ReturnStatement:
                    var hasArguments = node.argument;
                    result = "return" + (hasArguments ? (" " + this.expression(node.argument)) : "") + ";";
                    break;
            }
            return result;
        }
    };

    // Exports
    ns.ExpressionHandler = ExpressionHandler;


}(exports));

},{"../../base/common.js":82,"../../interfaces.js":111}],91:[function(require,module,exports){
(function (ns) {

    var Base = require("../../base/index.js");

    var Transformer = require("./transform.js").GLASTTransformer;
    var generate = require("./glsl-generate.js").generate;

    var GLSLCompiler = function () {

    };

    Base.extend(GLSLCompiler.prototype, {

        compileFragmentShader: function (aast, opt) {
            opt = opt || {};

            var transformer = new Transformer(aast, "global.shade", opt);

            //console.log(JSON.stringify(aast, 0, " "));

            var transformed = transformer.transform(aast);

            //console.log(JSON.stringify(aast, 0, " "));

            opt.headers = transformed.headers;
            var code = generate(transformed.program, opt);

            return {source: code, uniformSetter: transformed.uniformSetter};
        }

    });


    ns.GLSLCompiler = GLSLCompiler;

}(exports));

},{"../../base/index.js":85,"./glsl-generate.js":92,"./transform.js":104}],92:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var FunctionAnnotation = require("./../../base/annotation.js").FunctionAnnotation;
    var Shade = require("./../../interfaces.js");
    var walk = require('estraverse');
    var ExpressionHandler = require('../base/expression-handler.js').ExpressionHandler,
        Syntax = walk.Syntax,
        VisitorOption = walk.VisitorOption,
        ANNO = require("../../base/annotation.js").ANNO;


    // Shortcuts
    var Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS,
        Sources = Shade.SOURCES;

    var InternalFunctions = {
        "MatCol" : function(name, details){
            var matType = details.matType,
                colType = details.colType;
            return [matType + " " + name + "(" + matType + " mat, int idx, " + colType + " value){",
                  "  " + matType + " result = " + matType + "(mat);",
                  "  result[idx] = value;",
                  "  return result;",
                  "}"];
        }
    }

    var GLSL = {
        Storage: {
            CONST: "const",
            UNIFORM: "uniform",
            VARYING: "varying",
            ATTRIBUTE: "attribtue"
        }
    }

    var handler = new ExpressionHandler( {
        type: toGLSLType
    });


    /**
     * @param {object} opt
     */
    var getHeader = function (opt) {
        if (opt.omitHeader == true)
            return [];
        var header = [
            "// Generated by shade.js"
        ];
        if (opt.headers)
            header = header.concat(opt.headers)
        var floatPrecision = opt.floatPrecision || "highp";
        header.push("precision " + floatPrecision + " float;");
        header.push("");
        return header;
    }

    function toGLSLType(info, options) {
        if(!info) return "?";
        options = options || {};

        switch (info.type) {
            case Types.OBJECT:
                switch (info.kind) {
                    case Kinds.FLOAT4:
                        return "vec4";
                    case Kinds.FLOAT3:
                        return "vec3";
                    case Kinds.FLOAT2:
                        return "vec2";
                    case Kinds.TEXTURE:
                        return "sampler2D";
                    case Kinds.MATRIX3:
                        return "mat3";
                    case Kinds.MATRIX4:
                        return "mat4";
                    case Kinds.COLOR_CLOSURE:
                        return "vec4";
                    default:
                        return "<undefined>";
                }
            case Types.ARRAY:
                return toGLSLType(info.elements, options);

            case Types.UNDEFINED:
                if (options.allowUndefined)
                    return "void";
                throw new Error("Could not determine type");
            case Types.NUMBER:
                return "float";
            case Types.BOOLEAN:
                return "bool";
            case Types.INT:
                return "int";
            default:
                //throw new Error("toGLSLType: Unhandled type: " + info.type);
                return info.type;

        }
    }

    var toGLSLStorage = function(info) {
        if (!info.source)
            return null;
        if (info.source == Sources.VERTEX)
            return GLSL.Storage.VARYING;
        if (info.source == Sources.UNIFORM)
            return GLSL.Storage.UNIFORM;
        if (info.source == Sources.CONSTANT)
            return GLSL.Storage.CONST;
        throw new Error("toGLSLSource: Unhandled type: " + info.source);
    }

    function filterUndefined(arr) {
        return arr.filter(function(n) { return n.extra.type != Types.UNDEFINED; });
    }

    function createLineStack() {
        var arr = [];
        arr.push.apply(arr, arguments);
        var indent = "";
        arr.appendLine = function(line){
            line ? this.push(indent + line) : this.push("");
        };
        arr.changeIndention = function(add){
            while(add > 0){
                indent += "    "; add--;
            }
            if(add < 0){
                indent = indent.substr(0, indent.length + add*4);
            }
        };
        arr.append = function(str){
            this[this.length-1] = this[this.length-1] + str;
        };
        return arr;
    };


    /*Base.extend(LineStack.prototype, {

    });*/

    var generate = function (ast, opt) {

        opt = opt || {};

        var lines = createLineStack();

        traverse(ast, lines, opt);

        return lines.join("\n");
    }

    function appendInternalFunctions(lines, internalFunctions){
        if(!internalFunctions) return;
        for(var key in internalFunctions){
            var entry = internalFunctions[key];
            if(InternalFunctions[entry.type]){
                var linesToAdd = InternalFunctions[entry.type](entry.name, entry.details);
                lines.push.apply(lines, linesToAdd);
            }
            else{
                throw Error("Internal: InlineFunction of type '" + entry.type + "' not available!");
            }
        }
    }

    function traverse(ast, lines, opt) {
        var insideMain = false;


        walk.traverse(ast, {
                enter: function (node) {
                    try {
                        var type = node.type;
                        switch (type) {

                            case Syntax.Program:
                                getHeader(opt).forEach(function (e) {
                                    lines.push(e)
                                });
                                appendInternalFunctions(lines, ANNO(ast).getUserData().internalFunctions);
                                addForwardDeclarations(lines, node);
                                break;


                            case Syntax.FunctionDeclaration:
                                opt.newLines && lines.appendLine();
                                if(node.id.name == "main")
                                    insideMain = true;

                                lines.appendLine(generateFunctionSignature(node) + " {");
                                lines.changeIndention(1);
                                return;


                            case Syntax.ReturnStatement:
                                lines.appendLine(handler.statement(node));
                                return;

                            case Syntax.VariableDeclarator :
                                // console.log("Meep!");
                                var decl = handleVariableDeclaration(node, insideMain, opt);
                                lines.appendLine(decl);
                                return;

                            case Syntax.AssignmentExpression:
                            case Syntax.ExpressionStatement:
                                lines.appendLine(handler.expression(node) + ";")
                                return VisitorOption.Skip;;

                            case Syntax.IfStatement:
                                lines.appendLine("if(" + handler.expression(node.test, opt) + ") {");

                                lines.changeIndention(1);
                                traverse(node.consequent, lines, opt);
                                lines.changeIndention(-1);

                                if (node.alternate) {
                                    lines.appendLine("} else {");
                                    lines.changeIndention(1);
                                    traverse(node.alternate, lines, opt);
                                    lines.changeIndention(-1);
                                }
                                lines.appendLine("}");
                                return VisitorOption.Skip;

                            case Syntax.ForStatement:
                                lines.appendLine("for (" + handleInlineDeclaration(node.init, opt) + "; " + handler.expression(node.test, opt) +"; " + handler.expression(node.update, opt) + ") {");
                                lines.changeIndention(1);
                                traverse(node.body, lines, opt);
                                lines.changeIndention(-1);
                                lines.appendLine("}");
                                return VisitorOption.Skip;

                            case Syntax.ContinueStatement:
                                lines.appendLine("continue;");
                                return;
                            case Syntax.BreakStatement:
                                lines.appendLine("break;");
                                return;


                            default:
                            //console.log("Unhandled: " + type);

                        }
                    } catch (e) {
                        throw e;//console.error(e);
                        //Shade.throwError(node, e.message);
                    }
                },
                leave: function (node) {
                    var type = node.type;
                    switch (type) {
                        case Syntax.Program:
                            break;
                        case Syntax.FunctionDeclaration:
                            lines.changeIndention(-1);
                            lines.appendLine("}");
                            break;
                    }
                }
            }
        );
    }

    function addForwardDeclarations(lines, node) {
        var first = true;
        walk.traverse(node, {
            enter: function(node) {
                if(node.type == Syntax.FunctionDeclaration) {
                    if(node.id.name == "main") {
                        return;
                    }
                    if (first) {
                        first = false;
                        lines.appendLine("// Forward declarations");
                    }
                    lines.appendLine(generateFunctionSignature(node)+";");
                }
            }
        });
        if(!first) {
            lines.appendLine("");
        }
    }

    function generateFunctionSignature(node) {
        var func = new FunctionAnnotation(node);
        var methodStart = [toGLSLType(func.getReturnInfo(), { allowUndefined: true })];
        methodStart.push(node.id.name, '(');
        if (!(node.params && node.params.length)) {
            methodStart.push("void");
        } else {
            var methodArgs = [];
            node.params.forEach(function (param) {
                methodArgs.push(toGLSLType(param.extra) + " " + param.name);
            })
            methodStart.push(methodArgs.join(", "));
        }
        methodStart.push(")");
        return methodStart.join(" ");
    }

    function getStaticValue(extra) {
        if (!extra || extra.staticValue === undefined) return "";
        return extra.staticValue;
    };

    function handleVariableDeclaration(node, writeStorageQualifier, opt) {
        var storageQualifier = !writeStorageQualifier ? toGLSLStorage(node.extra) : null;
        var result = storageQualifier ? storageQualifier + " " : "";
        result += toGLSLType(node.extra) + " " + node.id.name;
        if (node.extra.elements) {
            result += "[" + (node.extra.staticSize ? node.extra.staticSize : "0") + "]";
        }
        if (node.init) result += " = " + handler.expression(node.init);
        if (!node.init && storageQualifier == GLSL.Storage.CONST) {
            result += " = " + getStaticValue(node.extra);
        }
        return result + ";";
    }


    function handleInlineDeclaration(node, opt) {
        if(!node)
            return "";
        if (node.type == Syntax.VariableDeclaration) {
            var result = node.declarations.reduce(function (declString, declaration) {
                var decl = toGLSLType(declaration.extra) + " " + declaration.id.name;
                if (declaration.init) {
                    decl += " = " + handler.expression(declaration.init);
                }
                return declString + decl;
            }, "");
            return result;
        }

        // GLSL allows only declaration in init, but since this is a new scope, it should be fine
        if (node.type == Syntax.AssignmentExpression) {
            return toGLSLType(node.extra) + " " + handler.expression(node.left) + " = " + handler.expression(node.right);
        }
        Shade.throwError(node, "Internal error in GLSL::handleInlineDeclaration, found " + node.type);
    }





    exports.generate = generate;


}(exports));

},{"../../base/annotation.js":80,"../base/expression-handler.js":90,"./../../base/annotation.js":80,"./../../interfaces.js":111,"estraverse":42}],93:[function(require,module,exports){
(function(ns) {

    var Scope = require("../../../base/scope.js"),
        Context = require("../../../base/context.js"),
        Base = require("../../../base/index.js"),
        Shade = require("../../../interfaces.js"),
        TypeInfo = require("../../../base/typeinfo.js").TypeInfo,
        common = require("../../../base/common.js");


    var Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS;

    var objects = {
        Shade : require("./shade.js"),
        Space : require("./space.js"),
        Math : require("./math.js"),
        System : require("./system.js"),
        Vec2 : require("./vec2.js"),
        Vec3 : require("./vec3.js"),
        Color: require("./vec3.js"),
        Vec4 : require("./vec4.js"),
        Mat3 : require("./mat3.js"),
        Mat4 : require("./mat4.js"),
        Texture : require("./texture.js")
    };

    var Registry = {
        name: "GLSLTransformRegistry",
        getByName: function(name) {
            var result = objects[name];
            return result || null;
        },
        getInstanceForKind: function(kind) {
            for(var obj in objects) {
                //noinspection JSUnfilteredForInLoop
                if (objects[obj].kind == kind) {
                    //noinspection JSUnfilteredForInLoop
                    return objects[obj].instance;
                }
            }
            return null;
        }
    };


    /**
     * @param root
     * @param {string} entry
     * @param opt
     * @extends {Context}
     * @constructor
     */
    var GLTransformContext = function(root, entry, opt) {
        Context.call(this, root, opt);
        this.usedParameters = {
            shader: {},
            system: {},
            uexp: {}
        };

        this.uniformExpressions = opt.uniformExpressions || {};


        this.systemParameters = {};
        this.blockedNames = [];
        this.topDeclarations = [];
        this.internalFunctions = {};
        this.idNameMap = {};
        this.headers = []; // Collection of header lines to define

        this.globalParameters = root.globalParameters && root.globalParameters[entry] && root.globalParameters[entry][0] ? root.globalParameters[entry][0].extra.info : {};


    };

    Base.createClass(GLTransformContext, Context, {
        createScope: function(node, parent, name) {
            return new GLTransformScope(node, parent, {name: name});
        },
        getTypeInfo: function(node) {
            return common.getTypeInfo(node, this.getScope());
        },
        addHeader: function(headerStr) {
            if (this.headers.indexOf(headerStr) == -1) {
                this.headers.push(headerStr);
            }
        }
    });

    /**
     * @constructor
     * @extends {Scope}
     */
    var GLTransformScope = function(node, parentScope, opt) {
        Scope.call(this, node, parentScope, opt);
        this.setRegistry(Registry);
    };

    Base.createClass(GLTransformScope, Scope, {

        registerGlobals: function() {
            this.registerObject("Math", objects.Math);
            this.registerObject("Color",  objects.Color);
            this.registerObject("Vec2", objects.Vec2);
            this.registerObject("Vec3", objects.Vec3);
            this.registerObject("Vec4", objects.Vec4);
            this.registerObject("Texture", objects.Texture);
            this.registerObject("Shade", objects.Shade);
            this.registerObject("Mat3", objects.Mat3);
            this.registerObject("Mat4", objects.Mat4);
            this.registerObject("Space", objects.Space);

            this.declareVariable("gl_FragCoord", false);
            this.updateTypeInfo("gl_FragCoord", new TypeInfo({
                extra: {
                    type: Types.OBJECT,
                    kind: Kinds.FLOAT3
                }
            }));
        }
    });



    ns.GLTransformScope = GLTransformScope;
    ns.GLTransformContext = GLTransformContext;

}(exports));

},{"../../../base/common.js":82,"../../../base/context.js":83,"../../../base/index.js":85,"../../../base/scope.js":86,"../../../base/typeinfo.js":87,"../../../interfaces.js":111,"./mat3.js":94,"./mat4.js":95,"./math.js":96,"./shade.js":97,"./space.js":98,"./system.js":99,"./texture.js":100,"./vec2.js":101,"./vec3.js":102,"./vec4.js":103}],94:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");
    var ANNO = require("../../../base/annotation.js").ANNO;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;

    var Mat3Instance = {
        col: {
            callExp: Tools.Mat.generateColCall.bind(null, "Mat3")
        }
    }
    Tools.Mat.attachOperators(Mat3Instance, "Mat3", {
        add: '+',
        sub: '-',
        mul: '*',
        div: '/'
    });
    Tools.Vec.attachOperators(Mat3Instance, 3, {
        mulVec: '*'
    });


    Tools.extend(ns, {
        id: "Mat3",
        kind: KINDS.MATRIX3,
        object: {
            constructor: Tools.Vec.generateConstructor,
            static: {}
        },
        instance: Mat3Instance
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],95:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");
    var ANNO = require("../../../base/annotation.js").ANNO;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;

    var Mat4Instance = {
        col: {
            callExp: Tools.Mat.generateColCall.bind(null, "Mat4")
        }
    }
    Tools.Mat.attachOperators(Mat4Instance, "Mat4", {
        add: '+',
        sub: '-',
        mul: '*',
        div: '/'
    });
    Tools.Vec.attachOperators(Mat4Instance, 4, {
        mulVec: '*'
    });


    Tools.extend(ns, {
        id: "Mat4",
        kind: KINDS.MATRIX4,
        object: {
            constructor: Tools.Vec.generateConstructor,
            static: {}
        },
        instance: Mat4Instance
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],96:[function(require,module,exports){
(function(ns){

   var Shade = require("../../../interfaces.js");
   var Syntax = require('estraverse').Syntax;
   var Tools = require("../../tools.js");

    var MathConstants = ["E", "PI", "LN2", "LOG2E", "LOG10E", "PI", "SQRT1_2", "SQRT2"];


    var handleIntVersion = function(node) {
        node.extra.type = Shade.TYPES.NUMBER;
        node.callee = Tools.removeMemberFromExpression(node.callee);
        return node;
    };

    var handleMathCall = function(opt) {
        opt = opt ||{};
        return function(node, args) {
            if (node.type !== Syntax.CallExpression) {
                Shade.throwError(node, "Internal Error in Math object");
            }
            // Cast all arguments of the math function to float, as they are
            // not defined for other types (int, bool)
            // Don't replace the arguments array, it's already cached by the traversal
            for(var i = 0; i < args.length; i++) {
                if (args[i].isInt())
                    node.arguments[i] = Tools.castToFloat(node.arguments[i]);
            }
            node.callee = Tools.removeMemberFromExpression(node.callee);
            if (opt.name) {
                node.callee.name = opt.name;
            }
            if (opt.arguments) {
                for (var idx = 0; idx < opt.arguments.length; ++idx)
                    if (typeof opt.arguments[idx] !== "undefined")
                        node.arguments[idx] = opt.arguments[idx];
            }
            return node;
        }
    };

    var MathEntry  = {
        abs: { callExp: handleMathCall() },
        acos: { callExp: handleMathCall() },
        asin: { callExp: handleMathCall() },
        atan: { callExp: handleMathCall() },
        atan2: { callExp: handleMathCall({ name: "atan" }) },
        ceil: { callExp: handleIntVersion },
        cos:  { callExp: handleMathCall() },
        exp: { callExp: handleMathCall() },
        floor: { callExp: handleMathCall() },
        // imul: { callExp: handleMathCall },
        log: { callExp: handleMathCall() },
        max: { callExp: handleMathCall() },
        min: { callExp: handleMathCall() },
        pow: { callExp: handleMathCall() },
        // random: function random() { [native code] }
        round: { callExp: handleMathCall() }, // Since GLSL 1.3, what does WebGL use?
        sin:  { callExp: handleMathCall() },
        sqrt: { callExp: handleMathCall() },
        tan: { callExp: handleMathCall() },

        // Non-standard methods
        clamp: { callExp: handleMathCall() },
        saturate: { callExp: handleMathCall({ name: "clamp", arguments: [
            undefined,
            {
                type: Syntax.Literal,
                value: 0.0,
                extra: {
                    type: Shade.TYPES.NUMBER,
                    staticValue: 0.0
                }
            },
            {
                type: Syntax.Literal,
                value: 1.0,
                extra: {
                    type: Shade.TYPES.NUMBER,
                    staticValue: 1.0
                }
            }
        ] }) },
        smoothstep: { callExp: handleMathCall() },
        step: { callExp: handleMathCall() },
        fract: { callExp: handleMathCall() },
        mix: { callExp: handleMathCall() }
    };

    MathConstants.forEach(function (constant) {
        MathEntry[constant] = {
            property: function () {
                return  { type: Syntax.Literal, value: Math[constant], extra: { type: Shade.TYPES.NUMBER } };
            }
        }
    });

    Tools.extend(ns, {
        id: "Math",
        object: {
            constructor: null,
            static: MathEntry
        },
        instance: MathEntry
    });

}(exports));

},{"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],97:[function(require,module,exports){
(function (ns) {

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");

    var ShadeInstance = {
        diffuse: {
            callExp: function(node) {
                return {
                    type: Syntax.BinaryExpression,
                    operator: "+",
                    left: {
                        type: Syntax.CallExpression,
                        callee: node.callee.property,
                        arguments: node.arguments
                    },
                    right: node.callee,
                    extra: {
                        type: Shade.TYPES.OBJECT,
                        kind: Shade.OBJECT_KINDS.COLOR_CLOSURE
                    }
                }
            }
        },
        phong: {

        }

    }

    Tools.extend(ns, {
        id: "Shade",
        kind: Shade.OBJECT_KINDS.COLOR_CLOSURE,
        object: {
            constructor: Tools.Vec.generateConstructor,
            static: {}
        },
        instance: ShadeInstance
    });

}(exports));

},{"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],98:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");


    function getSpaceTransform(spaceArg, normal){
        if( spaceArg.type != Syntax.MemberExpression ||
            spaceArg.object.type != Syntax.Identifier ||
            spaceArg.object.name != "Space" ||
            spaceArg.property.type != Syntax.Identifier)
            Shade.throwError(spaceArg, "We only support Space enums for the first argument of transformDirection and transformPoint");

        switch(spaceArg.property.name){
            case "VIEW": return normal ? "modelViewMatrixN" : "modelViewMatrix";
            case "WORLD": return normal ? "modelMatrixN" : "modelMatrix";
            default: Shade.throwError(spaceArg, "Unknown Space Type: '" + spaceArg.property.name + "'");
        }
    }

    var ANNO = require("../../../base/annotation.js").ANNO;
    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;
    var SpaceEntry  = {
        transformDirection: { callExp: function(callExpression, parent, context, state){
            var transform = getSpaceTransform(callExpression.arguments[0], true);
            var result = {  type: Syntax.BinaryExpression, operator: "*",
                            left: { type: Syntax.Identifier, name: transform},
                            right: callExpression.arguments[1]
            };

            ANNO(result).setType(TYPES.OBJECT, KINDS.FLOAT3);
            ANNO(result.left).setType(TYPES.OBJECT, KINDS.MATRIX3);
            ANNO(result.right).setType(TYPES.OBJECT, KINDS.FLOAT3);

            var systemName = Tools.getNameForSystem(transform);
            state.usedParameters.system[systemName] = state.systemParameters[transform];

            return result;
        } },
        transformPoint: { callExp: function(callExpression, parent, context, state){
            var transform = getSpaceTransform(callExpression.arguments[0], false);
            var result = {  type: Syntax.MemberExpression,
                            object: {  type: Syntax.BinaryExpression, operator: "*",
                                left: { type: Syntax.Identifier, name: transform},
                                right: {type: Syntax.CallExpression,
                                   callee: {type: Syntax.Identifier, name: "vec4"},
                                   arguments: [
                                        callExpression.arguments[1],
                                        { type: Syntax.Literal, value: 1, raw: 1}
                                   ]
                                }
                            },
                            property: { type: Syntax.Identifier, name: "xyz" }
                          };
            ANNO(result).setType(TYPES.OBJECT, KINDS.FLOAT3);
            ANNO(result.object).setType(TYPES.OBJECT, KINDS.FLOAT4);
            ANNO(result.object.left).setType(TYPES.OBJECT, KINDS.MATRIX4);
            ANNO(result.object.right).setType(TYPES.OBJECT, KINDS.FLOAT4);
            ANNO(result.object.right.arguments[1]).setType(TYPES.NUMBER);


            var systemName = Tools.getNameForSystem(transform);
            state.usedParameters.system[systemName] = state.systemParameters[transform];

            return result;
        } },
        VIEW: {
            property: function (memberExpression) {
                return memberExpression;
            }},
        WORLD: {
            property: function (memberExpression) {
                return  memberExpression;
            }}
    };

    Tools.extend(ns, {
        id: "Space",
        object: {
            constructor: null,
            static: SpaceEntry
        },
        instance: SpaceEntry
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],99:[function(require,module,exports){
(function (ns) {

    // Dependencies
    var Shade = require("../../../interfaces.js");
    var Tools = require("../../tools.js");
    var Syntax = require('estraverse').Syntax;

    // Shortcuts
    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;


    var SystemDefines = {};
    SystemDefines.CANVAS_DIMENSIONS = "coords";
    SystemDefines.DERIVATE_EXTENSION = "#extension GL_OES_standard_derivatives : enable";

    var CoordsType =  {
        type: Shade.TYPES.OBJECT,
        kind: Shade.OBJECT_KINDS.FLOAT3,
        source: Shade.SOURCES.UNIFORM
    };


    var DerivedParameters = {
        coords: {
            property: function (node) {
                node.property.name = "gl_FragCoord";
                return node.property;
            }
        },
        normalizedCoords: {
            property: function (node, parent, context, state) {
                var parameterName = Tools.getNameForSystem(SystemDefines.CANVAS_DIMENSIONS);
                var canvasDimensions = state.systemParameters[SystemDefines.CANVAS_DIMENSIONS];
                if(!canvasDimensions)
                   Shade.throwError(node, "Internal Error: No canavas dimensions defined" );

                state.usedParameters.system[parameterName] = canvasDimensions;

                return {
                    type: Syntax.NewExpression,
                    callee: {
                        type: Syntax.Identifier,
                        name: "Vec3"
                    },
                    arguments: [
                        {
                            type: Syntax.BinaryExpression,
                            left: {
                                type: Syntax.MemberExpression,
                                object: {
                                    type: Syntax.Identifier,
                                    name: "gl_FragCoord"
                                },
                                property: {
                                    type: Syntax.Identifier,
                                    name: "xyz"
                                }
                            },
                            right: {
                                type: Syntax.Identifier,
                                name: Tools.getNameForSystem(SystemDefines.CANVAS_DIMENSIONS)
                            },
                            operator: "/",
                            extra: {
                                type: Shade.TYPES.OBJECT,
                                kind: Shade.OBJECT_KINDS.FLOAT3
                            }
                        }
                    ],
                    extra: {
                        type: Shade.TYPES.OBJECT,
                        kind: Shade.OBJECT_KINDS.FLOAT3
                    }
                }
            }
        },
        height: {
            property: function (node, parent, context, state) {
                var parameterName = Tools.getNameForSystem(SystemDefines.CANVAS_DIMENSIONS);
                state.usedParameters.system[parameterName] = state.systemParameters[SystemDefines.CANVAS_DIMENSIONS];

                node.property.name = parameterName + ".y";
                return node.property;
            }
        },
        width: {
            property: function (node, parent, context, state) {
                var parameterName = Tools.getNameForSystem(SystemDefines.CANVAS_DIMENSIONS);
                state.usedParameters.system[parameterName] = state.systemParameters[SystemDefines.CANVAS_DIMENSIONS];

                node.property.name = parameterName + ".x";
                return node.property;
            }
        },
        fwidth: {
            property: function (node, parent, context, state) {
                state.addHeader(SystemDefines.DERIVATE_EXTENSION);
                return Tools.removeMemberFromExpression(node);
            }
        },
        dx: {
            property: function (node, parent, context, state) {
                state.addHeader(SystemDefines.DERIVATE_EXTENSION);
                var result = Tools.removeMemberFromExpression(node);
                result.name = "dFdx";
                return result;
            }
        },
        dy: {
            property: function (node, parent, context, state) {
                state.addHeader(SystemDefines.DERIVATE_EXTENSION);
                var s = Tools.removeMemberFromExpression(node);
                var result = Tools.removeMemberFromExpression(node);
                result.name = "dFdy";
                return result;
            }
        }

    };

    Tools.extend(ns, {
        id: "System",
        object: {
            constructor: null,
            static: DerivedParameters
        },
        instance: null,
        derivedParameters: DerivedParameters
    });
}(exports));

},{"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],100:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");
    var ANNO = require("../../../base/annotation.js").ANNO;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;

    var TextureInstance = {
        sample2D: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'texture2D', 2)
        },
        width: {
            property: function (node, parent, context, state) {
                var parameterName = node.object.name;
                node.property.name = parameterName + "_width";
                state.usedParameters.shader[parameterName + "_width"] = {
                    type: Shade.TYPES.INT,
                    kind: Shade.OBJECT_KINDS.INT,
                    source: Shade.SOURCES.UNIFORM
                };
                return node.property;
            }
        },
        height: {
            property: function (node, parent, context, state) {
                var parameterName = node.object.name;
                node.property.name = parameterName + "_height";
                state.usedParameters.shader[parameterName + "_height"] = {
                    type: Shade.TYPES.INT,
                    kind: Shade.OBJECT_KINDS.INT,
                    source: Shade.SOURCES.UNIFORM
                };
                return node.property;
            }
        }
    }

    Tools.extend(ns, {
        id: "Texture",
        kind: KINDS.TEXTURE,
        object: {
            constructor: null,
            static: {}
        },
        instance: TextureInstance
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],101:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");
    var ANNO = require("../../../base/annotation.js").ANNO;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;

    var Vec2Instance = {
        normalize: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'normalize', 0)
        },
        flip: {
            callExp: Tools.Vec.createFunctionCall.bind(null, '-', 0)
        },
        dot: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'dot', 2)
        },
        reflect: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'reflect', 2)
        },
        length: {
            callExp: Tools.Vec.generateLengthCall
        }
    }
    Tools.Vec.attachSwizzles(Vec2Instance, 2, Tools.Vec.createSwizzle, Tools.Vec.createSwizzleOperator);
    Tools.Vec.attachOperators(Vec2Instance, 2, {
        add: '+',
        sub: '-',
        mul: '*',
        div: '/',
        mod: '%'
    })


    Tools.extend(ns, {
        id: "Vec2",
        kind: KINDS.FLOAT2,
        object: {
            constructor: Tools.Vec.generateConstructor,
            static: {}
        },
        instance: Vec2Instance
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],102:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");
    var ANNO = require("../../../base/annotation.js").ANNO;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;

    var Vec3Instance = {
        normalize: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'normalize', 0)
        },
        flip: {
            callExp: Tools.Vec.createFunctionCall.bind(null, '-', 0)
        },
        dot: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'dot', 3)
        },
        reflect: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'reflect', 3)
        },
        refract: {
            callExp: function (node, args, parent) {
                var eta = node.arguments.pop();
                var result = Tools.Vec.createFunctionCall("refract", 3, node, args, parent);
                ANNO(eta).setType(TYPES.NUMBER);
                result.arguments.push(eta);
                return result;
            }
        },
        length: {
            callExp: Tools.Vec.generateLengthCall
        },
        cross: {
            callExp: Tools.Vec.createFunctionCall.bind(null, "cross", 3)
        }
    }
    Tools.Vec.attachSwizzles(Vec3Instance, 3, Tools.Vec.createSwizzle, Tools.Vec.createSwizzleOperator);
    Tools.Vec.attachOperators(Vec3Instance, 3, {
        add: '+',
        sub: '-',
        mul: '*',
        div: '/',
        mod: '%'
    })


    Tools.extend(ns, {
        id: "Vec3",
        kind: KINDS.FLOAT3,
        object: {
            constructor: Tools.Vec.generateConstructor,
            static: {}
        },
        instance: Vec3Instance
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],103:[function(require,module,exports){
(function(ns){

    var Shade = require("../../../interfaces.js");
    var Syntax = require('estraverse').Syntax;
    var Tools = require("../../tools.js");
    var ANNO = require("../../../base/annotation.js").ANNO;

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;

    var Vec4Instance = {
        normalize: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'normalize', 0)
        },
        flip: {
            callExp: Tools.Vec.createFunctionCall.bind(null, '-', 0)
        },
        dot: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'dot', 4)
        },
        reflect: {
            callExp: Tools.Vec.createFunctionCall.bind(null, 'reflect', 4)
        },
        length: {
            callExp: Tools.Vec.generateLengthCall
        }
    }
    Tools.Vec.attachSwizzles(Vec4Instance, 4, Tools.Vec.createSwizzle, Tools.Vec.createSwizzleOperator);
    Tools.Vec.attachOperators(Vec4Instance, 4, {
        add: '+',
        sub: '-',
        mul: '*',
        div: '/',
        mod: '%'
    })


    Tools.extend(ns, {
        id: "Vec4",
        kind: KINDS.FLOAT4,
        object: {
            constructor: Tools.Vec.generateConstructor,
            static: {}
        },
        instance: Vec4Instance
    });

}(exports));

},{"../../../base/annotation.js":80,"../../../interfaces.js":111,"../../tools.js":109,"estraverse":42}],104:[function(require,module,exports){
(function (ns) {

    var Base = require("../../base/index.js"),
        common = require("../../base/common.js"),
        FunctionAnnotation = require("../../base/annotation.js").FunctionAnnotation,
        Shade = require("./../../interfaces.js"),
        Types = Shade.TYPES,
        analyses = require('analyses'),
        Tools = require('../tools.js'),
        System = require('./registry/system.js'),
        assert = require('assert');


    var Context = require("./registry/").GLTransformContext;


    var walk = require('estraverse');
    var Syntax = walk.Syntax;
    var ANNO = common.ANNO;
    var Map = common.Map;
    var Set = analyses.Set;


    /**
     * Transforms the JS AST to an AST representation convenient
     * for code generation
     * @constructor
     */
    var GLASTTransformer = function (root, mainId, opt) {
        this.context = new Context(root, mainId, opt);
    };

    function createUniformDependencyMap(uniformExpressions) {
        var name, uexpSet, dependencies, dependency, dl, dependencyMap = new Map();
        for (name in uniformExpressions) {
            dependencies = uniformExpressions[name].dependencies;
            dl = dependencies.length;
            while (dl--) {
                dependency = dependencies[dl];
                if (dependencyMap.has(dependency)) {
                    uexpSet = dependencyMap.get(dependency);
                } else {
                    uexpSet = new Set();
                    dependencyMap.set(dependency, uexpSet);
                }
                uexpSet.add(name);
            }
        }
        return dependencyMap;
    }

    Base.extend(GLASTTransformer.prototype, {
        /**
         *
         * @param {GLTransformScope} scope
         */
        registerThisObject: function (scope) {
            var thisObject = scope.getBindingByName("this");
            if (thisObject && thisObject.isObject()) {
                var properties = thisObject.getNodeInfo();
                for (var name in properties) {
                    var prop = ANNO({}, properties[name]);
                    if (!prop.isDerived())
                        this.context.blockedNames.push(Tools.getNameForSystem(name));
                }
                for (var property in System.derivedParameters) {
                    if(properties.hasOwnProperty(property)) {
                        Base.deepExtend(properties[property], System.derivedParameters[property]);
                    }
                }
                Base.extend(this.context.systemParameters, properties);
            }
        },


        createUniformSetterFunction: function (parameters) {
            // Reverse uniform expression dependencies
            var c_dependencyMap = createUniformDependencyMap(parameters.uexp);

            return function (envNames, sysNames, inputCollection, cb) {
                var i, base, override, srcName, destName, ul, uniformList;
                if (envNames && inputCollection.envBase) {
                    i = envNames.length;
                    base = inputCollection.envBase;
                    override = inputCollection.envOverride;
                    while (i--) {
                        srcName = envNames[i];
                        if(c_dependencyMap.has(srcName)) {
                            uniformList = c_dependencyMap.get(srcName).values();
                            ul = uniformList.length;
                            while(ul--) {
                                var expName = uniformList[ul];
                                var expression = parameters.uexp[expName];
                                var value = expression.setter.call(Shade, inputCollection.envBase);
                                cb(expName, value);
                            }
                        }
                        destName = Tools.getNameForGlobal(envNames[i]);
                        if (!parameters.shader[destName])
                            continue;
                        cb(destName, override && override[srcName] !== undefined ? override[srcName] : base[srcName]);
                        if (parameters.shader[destName].kind === Shade.OBJECT_KINDS.TEXTURE) {
                            cb(destName + "_width", override && override[srcName] !== undefined ? override[srcName].width : base[srcName] && base[srcName][0].width || 0);
                            cb(destName + "_height", override && override[srcName] !== undefined ? override[srcName].height : base[srcName] && base[srcName][0].height || 0)
                        }
                    }
                }
                if (sysNames && inputCollection.sysBase) {
                    i = sysNames.length;
                    base = inputCollection.sysBase;
                    while (i--) {
                        srcName = sysNames[i];
                        destName = Tools.getNameForSystem(sysNames[i]);
                        cb(destName, base[srcName]);
                    }
                }
            }

        },

        transform: function () {
            var context = this.context,
                program = context.root,
                scope = context.createScope(this.context.root, null, "global"),
                name, declaration;

            scope.registerGlobals();
            context.pushScope(scope);

            this.registerThisObject(scope);

            // TODO: We should also block systemParameters here. We can block all system names, even if not used.
            for(name in context.globalParameters){
                context.blockedNames.push( Tools.getNameForGlobal(name) );
            }

            this.replace(program);

            var usedParameters = context.usedParameters;
            for (var container in usedParameters) {
                for (name in usedParameters[container]) {
                    declaration = createTopDeclaration(name, usedParameters[container][name]);
                    declaration && program.body.unshift(declaration);
                }
            }

            var uniformSetter = this.createUniformSetterFunction(usedParameters);

            var userData = ANNO(program).getUserData();
            userData.internalFunctions = context.internalFunctions;

            return { program: program, uniformSetter: uniformSetter, headers: context.headers};
        },
        /**
         *
         * @param {Object!} ast
         * @returns {*}
         */
        replace: function(ast) {
            var controller = new walk.Controller(),
                context = this.context,
                that = this;

            ast = controller.replace(ast, {

                enter: function (node, parent) {

                    switch (node.type) {
                        case Syntax.Identifier:
                            return enterIdentifier(node, parent, context);
                        case Syntax.IfStatement:
                            return enterIfStatement(node);
                        case Syntax.FunctionDeclaration:
                            return enterFunctionDeclaration(node, context);
                    }
                },

                leave: function(node, parent) {
                    switch(node.type) {
                        case Syntax.MemberExpression:
                            return leaveMemberExpression(node, parent, context);
                        case Syntax.NewExpression:
                            return leaveNewExpression(node, context);
                        case Syntax.LogicalExpression:
                            return leaveLogicalExpression(node);
                        case Syntax.CallExpression:
                            return leaveCallExpression(node, parent, context);
                        case Syntax.UnaryExpression:
                            return leaveUnaryExpression(node);
                        case Syntax.FunctionDeclaration:
                            return leaveFunctionDeclaration(node, context);
                        case Syntax.ReturnStatement:
                            return leaveReturnStatement(node, context);
                        case Syntax.BinaryExpression:
                            return handleBinaryExpression(node, parent, context);

                    }
                }
            });
            return ast;
        }
    });

    /**
     * @param {string} name
     * @param {object} typeInfo
     * @returns {*}
     */
    var createTopDeclaration = function(name, typeInfo){
        var propertyLiteral =  { type: Syntax.Identifier, name: name};
        var propertyAnnotation =  ANNO(propertyLiteral);
        propertyAnnotation.setFromExtra(typeInfo);

        if (propertyAnnotation.isNullOrUndefined() || propertyAnnotation.isDerived() || propertyAnnotation.isFunction())
            return;

        if( propertyAnnotation.isOfType(Types.ARRAY) && typeInfo.staticSize == 0)
            return;

        var decl = {
            type: Syntax.VariableDeclaration,
            declarations: [
                {
                    type: Syntax.VariableDeclarator,
                    id: propertyLiteral,
                    init: null
                }
            ],
            kind: "var"
        };
        var declAnnotation =  ANNO(decl.declarations[0]);
        declAnnotation.copy(propertyAnnotation);
        return decl;
    };

    var enterIdentifier = function(node, parent, state){
        var blockedNames = state.blockedNames;
        var idNameMap = state.idNameMap;

        if(parent.type == Syntax.MemberExpression)
            return node;
        var name = node.name;
        if(idNameMap[name]) {
            node.name = idNameMap[name];
            return node;
        }
        var newName = Tools.generateFreeName(name, blockedNames);
        idNameMap[name] = newName;
        node.name = newName;
        return node;
    };


    /**
     * Transform a !number expression into an binary expression, number == 0
     * @param node
     * @returns {*}
     */
    var leaveUnaryExpression = function(node) {
        if(node.operator == "!") {
            var argument = ANNO(node.argument);
            //noinspection FallthroughInSwitchStatementJS
            switch(argument.getType()) {
                case Types.INT:
                case Types.NUMBER:
                    return {
                        type: Syntax.BinaryExpression,
                        operator: "==",
                        left: node.argument,
                        right: {
                            type: Syntax.Literal,
                            value: 0,
                            extra: {
                                type: argument.getType()
                            }
                        }
                    };
                    break;
            }
        }
    };

    /**
     * A return in the main functions sets gl_FragColor or discard if the
     * main method returns without argument
     * @param node
     * @param {GLTransformContext} context
     * @returns {*}
     */
    var leaveReturnStatement = function(node, context) {
        var scope = context.getScope(), fragColors;

        if(!context.inMainFunction())
            return;

        if (node.argument) {
            var argument = ANNO(node.argument);
            if (argument.isArray()) {
               context.addHeader("#extension GL_EXT_draw_buffers : require");
               fragColors = {type: Syntax.BlockStatement, body: []};
               node.argument.elements.forEach(function(element, index) {
                    fragColors.body.push(createGLFragColor(Tools.castToVec4(element, scope), index));
               });
            } else {
                fragColors = createGLFragColor(Tools.castToVec4(node.argument, scope));
            }
            return {
                type: Syntax.BlockStatement,
                body: [ fragColors, { type: Syntax.ReturnStatement } ]
            };

        } else {
            return {
                type: Syntax.ExpressionStatement,
                expression : {
                    type: Syntax.Identifier,
                    name: "discard"
                }
            }
        }
    };

    /**
     * Transform the main function into a GLSL conform main function
     * with signature 'void main(void)'
     * @param node
     */
    var leaveMainFunction = function(node) {
        var anno = new FunctionAnnotation(node);
        anno.setReturnInfo({ type: Types.UNDEFINED });

        // Main has no parameters
        node.params = [];
        // Rename to 'main'
        node.id.name = "main";
        //console.log(node);
    };

    function createGLFragColor(result, index) {
        return {
            type: Syntax.AssignmentExpression,
            operator: "=",
            left: {
                type: Syntax.Identifier,
                name: (index !== undefined ? "gl_FragData[" + index + "]" : "gl_FragColor")
            },
            right: result
        };
    }

    function getNameOfNode(node) {
        switch (node.type) {
            case Syntax.Identifier:
                return node.name;
            case Syntax.MemberExpression:
                return getNameOfNode(node.object) + "." + getNameOfNode(node.property);
            case Syntax.NewExpression:
                return getNameOfNode(node.callee);
            default:
                return "unknown(" + node.type + ")";
        }
    }

    /**
     *
     * @param {object} node
     * @param {object} parent
     * @param {GLTransformContext} context
     * @returns {*}
     */
    var leaveCallExpression = function (node, parent, context) {
        var scope = context.getScope();

        /** Filter out undefined arguments, we do the same for the declaration */
        node.arguments = node.arguments.filter(function(a) { return !ANNO(a).isUndefined()});

        // Is this a call on an object?
        if (node.callee.type == Syntax.MemberExpression) {
            var calleeReference = common.getTypeInfo(node.callee, scope);
            if(!(calleeReference && calleeReference.isFunction()))
                Shade.throwError(node, "Something went wrong in type inference, " + node.callee.object.name);

            var object = node.callee.object,
                propertyName = node.callee.property.name;

            var objectReference = common.getTypeInfo(object, scope);
            if(!objectReference)  {
                Shade.throwError(node, "Internal: No type info for: " + object);
            }

            var objectInfo = scope.getObjectInfoFor(objectReference);
            if(!objectInfo) { // Every object needs an info, otherwise we did something wrong
                Shade.throwError(node, "Internal Error: No object registered for: " + objectReference.getTypeString() + ", " + getNameOfNode(node.callee.object)+", "+node.callee.object.type);
            }
            if (objectInfo.hasOwnProperty(propertyName)) {
                var propertyHandler = objectInfo[propertyName];
                if (typeof propertyHandler.callExp == "function") {
                    var args = common.createTypeInfo(node.arguments, scope);
                    return propertyHandler.callExp(node, args, parent, context);
                }
            }
        }
    };

    var leaveNewExpression = function(newExpression, context){
        var scope = context.getScope();
        var entry = scope.getBindingByName(newExpression.callee.name);
        //console.error(entry);
        if (entry && entry.hasConstructor()) {
            var constructor = entry.getConstructor();
            return constructor(newExpression);
        }
       else {
            throw new Error("ReferenceError: " + newExpression.callee.name + " is not defined");
        }
    };


    /**
     *
     * @param {object} node
     * @param {object} parent
     * @param {GLTransformContext} context
     * @returns {*}
     */
    var leaveMemberExpression = function (node, parent, context) {
        var propertyName = node.property.name,
            scope = context.getScope(),
            parameterName,
            propertyLiteral;

        if (node.computed) {
            return handleComputedMemberExpression(node, parent, context);
        }

        if(ANNO(node).isUniformExpression()) {
            var uexp = handleUniformExpression(node, context);
            if(uexp)
                return uexp;
        }

        var objectReference = common.getTypeInfo(node.object, scope);

        if (!objectReference || !objectReference.isObject()) {
            Shade.throwError(node, "Internal Error: Object of Member expression is no object.");
        }


        var objectInfo = scope.getObjectInfoFor(objectReference);
        if(!objectInfo) {// Every object needs an info, otherwise we did something wrong
            Shade.throwError(node, "Internal Error: No object registered for: " + objectReference.getTypeString() + JSON.stringify(node.object));
        }
        if (!objectInfo.hasOwnProperty(propertyName))
            Shade.throwError(node, "Internal Error: Object of type " + objectReference.getTypeString() + " has no property '" + propertyName +"'");

        var propertyHandler = objectInfo[propertyName];
        if (typeof propertyHandler.property == "function") {
            return propertyHandler.property(node, parent, scope, context);
        }

        var usedParameters = context.usedParameters;
        if(objectReference.isGlobal()) {
            parameterName = Tools.getNameForGlobal(propertyName);
            if(!usedParameters.shader.hasOwnProperty(parameterName)) {
                usedParameters.shader[parameterName] = context.globalParameters[propertyName];
            }

            propertyLiteral =  { type: Syntax.Identifier, name: parameterName};
            ANNO(propertyLiteral).copy(ANNO(node));
            return propertyLiteral;
        }
        if (node.object.type == Syntax.ThisExpression) {
            parameterName = Tools.getNameForSystem(propertyName);
            if(!usedParameters.system.hasOwnProperty(parameterName)) {
                usedParameters.system[parameterName] = context.systemParameters[propertyName];
            }

            propertyLiteral =  { type: Syntax.Identifier, name: parameterName};
            ANNO(propertyLiteral).copy(ANNO(node));
            return propertyLiteral;
        }

    };

    /**
     * @param {object} node
     * @param {object} parent
     * @param {GLASTTransformer} context
     */
    var handleComputedMemberExpression = function(node, parent, context) {
        var objectReference = context.getTypeInfo(node.object);
        if (!objectReference.isArray()) {
            Shade.throwError(node, "In shade.js, [] access is only allowed on arrays.");
        }
    };


    /**
     * @param {object} node
     * @param {object} parent
     * @param {GLASTTransformer} context
     */
    var handleBinaryExpression = function (node, parent, context) {
        // In GL, we can't mix up floats, ints and bool for binary expressions
        var left = context.getTypeInfo(node.left),
            right = context.getTypeInfo(node.right);

        if (left.isNumber() && right.isInt()) {
            node.right = Tools.castToFloat(node.right);
        }
        else if (right.isNumber() && left.isInt()) {
            node.left = Tools.castToFloat(node.left);
        }

        if (node.operator == "%") {
            return Tools.binaryExpression2FunctionCall(node, "mod");
        }
        return node;
    };

    /*function castToInt(ast, force) {
        var exp = ANNO(ast);

        if (!exp.isInt() || force) {   // Cast
            return {
                type: Syntax.CallExpression,
                callee: {
                    type: Syntax.Identifier,
                    name: "int"
                },
                arguments: [ast]
            };
        }
        return ast;
    };*/

    /**
     * @param {Object} node
     * @param {GLTransformContext} context
     * @returns {*}
     */
    var enterFunctionDeclaration = function(node, context) {
        var scope = context.createScope(node, context.getScope(), node.id.name);
        context.pushScope(scope);

        var newParameterList = [];
        // Remove parameters of type undefined (these are not used anyway)
        node.params.forEach(function(a) {
            // Don't declare undefined parameters
            if(!ANNO(a).isUndefined()){
                newParameterList.push(a);
            } else {
                var binding = scope.getBindingByName(a.name);
                if(!binding.isUndefined()) {
                    addDeclaration(a.name, binding, node.body);
                }
            }
        });
        node.params = newParameterList;
        return node;
    };

    /**
     * @param {Object} node
     * @param {GLTransformContext} context
     * @returns {*}
     */
    var leaveFunctionDeclaration = function(node, context) {
        var wasMain = context.inMainFunction();
        context.popScope();
        if (wasMain)
            return leaveMainFunction(node);
    };


    var enterIfStatement = function (node) {
        var test = ANNO(node.test);

       assert(!test.hasStaticValue(), "Static value in IfStatement test");
       assert(!test.isObject(), "Object in IfStatement test");

       //noinspection FallthroughInSwitchStatementJS
        switch(test.getType()) {
           // Transform 'if(number)' into 'if(number != 0)'
           case Types.INT:
           case Types.NUMBER:
               node.test = {
                   type: Syntax.BinaryExpression,
                   operator: "!=",
                   left: node.test,
                   right: {
                       type: Syntax.Literal,
                       value: 0,
                       extra: {
                           type: test.getType()
                       }
                   }
               };
               break;
       }
    };

    /**
     * Need to transform truth expressions in real boolean expression, because something like if(0) is
     * not allowed in GLSL
     *
     * @param node
     * @returns {*}
     */
    var leaveLogicalExpression = function(node) {
        var left = ANNO(node.left);
        var right = ANNO(node.right);

        if (left.isBool() && right.isBool()) {
            // Everything is okay, no need to modify anything
            return;
        }

        // Now we have to implement the JS boolean semantic for GLSL
        if (left.canNumber()) {
            var test =  node.left;
            return {
                type: Syntax.ConditionalExpression,
                test: {
                    type: Syntax.BinaryExpression,
                    operator: "==",
                    left: test,
                    right: {
                        type: Syntax.Literal,
                        value: left.isNumber() ? 0.0 : left.isInt() ? 0 : "false",
                        extra: {
                            type : left.getType(),
                            staticValue: left.isNumber() ? 0.0 : left.isInt() ? 0 : "false"
                        }
                    },
                    extra: { type: Types.BOOLEAN }
                },
                consequent: node.right,
                alternate: test
            };
        }
    };


    function handleUniformExpression(node, context) {
            var exp = ANNO(node),
                extra;

            if (exp.isUniformExpression() && !(exp.getSource() == Shade.SOURCES.UNIFORM)) {
                var uniformName = node.property.name;

                if (context.usedParameters.uexp.hasOwnProperty(uniformName)) { // Reuse
                    extra = context.usedParameters.uexp[uniformName];
                    return {
                        type: Syntax.Identifier,
                        name: uniformName,
                        extra: extra
                    }
                }

                // Generate new uniform expression
                extra = {};

                if(!context.uniformExpressions.hasOwnProperty(uniformName)) {
                    throw new Error("Internal: No information about uniform expression available: " + Shade.toJavaScript(node));
                }
                extra.setter = generateUniformSetter(exp, context.uniformExpressions[uniformName]);

                //console.log(uniformName, extra.setter);

                extra.type = exp.getType();
                if (exp.isObject()) {
                    extra.kind = exp.getKind();
                }
                extra.source = Shade.SOURCES.UNIFORM;
                extra.dependencies = exp.getUniformDependencies();

                context.usedParameters.uexp[uniformName] = extra;

                return {
                    type: Syntax.Identifier,
                    name: uniformName,
                    extra: extra
                }
            }
        }

    function generateUniformSetter(uniformAnno, expressionInfo) {
        var code = expressionInfo.code;
        if(uniformAnno.isObject())
            code = "(" + expressionInfo.code + ")._toFloatArray()";
        var source = "return " + code + ";";
        return new Function("env", source);
    }

    function addDeclaration(name, typeInfo, target) {
        var targetContainer, declaration;
        switch (target.type) {
            case Syntax.BlockStatement:
                targetContainer = target.body;
                break;
            default:
                throw new Error("Internal: addDeclaration to " + target.type);
        }
        if (targetContainer.length && targetContainer[0].type == Syntax.VariableDeclaration) {
           declaration = targetContainer[0];
           //console.log(declaration.declarations.push(declaration.declarations[0]));
        } else {
            declaration = {
                type: Syntax.VariableDeclaration,
                kind: "var",
                declarations: []
            }
            targetContainer.unshift(declaration);
        }
        var declarator = {
            type: Syntax.VariableDeclarator,
            id: {
                type: Syntax.Identifier,
                name: name
            },
            init: null
        };
        ANNO(declarator).copy(typeInfo);
        declaration.declarations.push(declarator);
    }


    // Exports
    ns.GLASTTransformer = GLASTTransformer;


}(exports));

},{"../../base/annotation.js":80,"../../base/common.js":82,"../../base/index.js":85,"../tools.js":109,"./../../interfaces.js":111,"./registry/":93,"./registry/system.js":99,"analyses":1,"assert":43,"estraverse":42}],105:[function(require,module,exports){
(function (ns) {

    var common = require("../../base/common.js"),
        parser = require('esprima'),
        Shade = require("./../../interfaces.js"),
        Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS,
        analyzer = require("../../analyze/analyze.js");
    var walk = require('estraverse');
    var Syntax = walk.Syntax;

    var Template = require("./light-pass-template").LightPassTemplate;
    var ArgStorageType = require("../../resolve/xml3d-glsl-deferred/color-closure-signature.js").ArgStorageType;

    var PRE_TEXTURE_FETCHES = 2,
        POSITION_IS_IN_ARGS = true,
        TEXCOORD_NAME = "texcoord",
        DEFERRED_TEX_PREFIX = "deferred",
        DEFERRED_VALUE_PREFIX = "deferred";

    function getInputArgDeclaration(colorClosureSignature){
        var declarations = [];
        var defaultArgCount = POSITION_IS_IN_ARGS ? 3 : 2;
        for(var i = 0; i < colorClosureSignature.args.length - defaultArgCount; ++i){
            declarations.push({ type: Syntax.VariableDeclarator,
            id: {type: Syntax.Identifier, name: "cc" + colorClosureSignature.id + "Arg" + i},
            init: null});
        }
        return {
            type: Syntax.VariableDeclaration,
            kind: "var",
            declarations: declarations
        };
    }

    function createTexMethodAccess(texId, method){
        return {type: Syntax.CallExpression,
            callee: { type: Syntax.MemberExpression,
                object: {type: Syntax.Identifier, name: DEFERRED_VALUE_PREFIX + texId },
                property: {type: Syntax.Identifier, name: method}},
            arguments: []};
    }

    var FetchResolver = {};
    FetchResolver[ArgStorageType.FLOAT] = function(arg){
        var functionName;
        switch(arg.componentIdx){
            case 0: functionName = "x"; break;
            case 1: functionName = "y"; break;
            case 2: functionName = "z"; break;
            case 3: functionName = "w"; break;
        }
        return createTexMethodAccess(arg.texIdx, functionName);
    }
    FetchResolver[ArgStorageType.FLOAT2] = function(arg){
        var functionName;
        switch(arg.componentIdx){
            case 0: functionName = "xy"; break;
            case 1: functionName = "yz"; break;
            case 2: functionName = "zw"; break;
        }
        return createTexMethodAccess(arg.texIdx, functionName);
    }
    FetchResolver[ArgStorageType.FLOAT3] = function(arg){
        var functionName;
        switch(arg.componentIdx){
            case 0: functionName = "xyz"; break;
            case 1: functionName = "yzw"; break;
        }
        return createTexMethodAccess(arg.texIdx, functionName);
    }
    FetchResolver[ArgStorageType.FLOAT4] = function(arg){
        return createTexMethodAccess(arg.texIdx, "xyzw");
    }

    function addTextureSamples(statements, colorClosureSignature){
        for(var i = PRE_TEXTURE_FETCHES; i < colorClosureSignature.textureCount; ++i){
            statements.push(
            {type: Syntax.ExpressionStatement,
                expression: {type: Syntax.AssignmentExpression, operator: "=",
                    left: { type: Syntax.Identifier, name: DEFERRED_VALUE_PREFIX + i },
                    right: { type: Syntax.CallExpression,
                        callee: {type: Syntax.MemberExpression,
                            object: {type: Syntax.MemberExpression,
                                object: {type: Syntax.Identifier, name: "env"},
                                property: {type: Syntax.Identifier, name: DEFERRED_TEX_PREFIX + i }},
                            property: {type: Syntax.Identifier, name: "sample2D"}},
                        arguments: [{ type: Syntax.Identifier, name: TEXCOORD_NAME }]
                    }
                }
            });
        }
    }
    function addArgumentFetching(statements, colorClosureSignature){
        var id = colorClosureSignature.id;
        var defaultArgCount = POSITION_IS_IN_ARGS ? 3 : 2;
        var args = colorClosureSignature.args;
        for(var i = defaultArgCount; i < args.length; ++i){
            var arg = args[i];
            if(!FetchResolver[arg.storeType])
                throw new Error("StoreType '" + arg.storeType + "' not supported in light pass shader");
            var valueFetchAst = FetchResolver[arg.storeType](arg);
            statements.push({type: Syntax.ExpressionStatement,
                expression: {type: Syntax.AssignmentExpression, operator: "=",
                    left: {type: Syntax.Identifier, name: "cc" + id + "Arg" + (i - defaultArgCount)},
                    right: valueFetchAst
                    }});
        }
    }

    function getColorClosureArgs(id, ccEntry){
        var defaultArgCount = POSITION_IS_IN_ARGS ? 3 : 2;
        var args = [], argIndices = ccEntry.argIndices;
        for(var i = 0; i < argIndices.length; ++i){
            args.push({type: Syntax.Identifier, name: "cc" + id + "Arg" + (argIndices[i] - defaultArgCount)});
        }
        return args;
    }

    function getReturnStatement(colorClosureSignature){

        var returnArgument = { type: Syntax.NewExpression,
            callee: {type: Syntax.Identifier, name: "Shade"},
            arguments: []};
        var ccList = colorClosureSignature.colorClosures;
        for(var i = 0; i < ccList.length; ++i){
            var args = getColorClosureArgs(colorClosureSignature.id, ccList[i]);
            returnArgument = {  type: Syntax.CallExpression,
                                callee: {type: Syntax.MemberExpression,
                                    object: returnArgument,
                                    property: {type: Syntax.Identifier, name: ccList[i].name}},
                                arguments: args};
        }

        return {type: Syntax.ReturnStatement,
            argument: returnArgument};
    }


    function getIfStatement(colorClosureSignature){
        var statements = [];
        statements.push(getInputArgDeclaration(colorClosureSignature));
        addTextureSamples(statements, colorClosureSignature);
        addArgumentFetching(statements, colorClosureSignature);
        statements.push(getReturnStatement(colorClosureSignature));

        return  { type: Syntax.IfStatement,
                    test: {type: Syntax.BinaryExpression, operator: "==",
                        left: {type: Syntax.Identifier, name: "ccId"},
                        right: {type: Syntax.Literal, value: colorClosureSignature.id }
                    },
                    consequent: { type: Syntax.BlockStatement,
                        body: statements},
                    alternate: null
                };
    }

    ns.generateLightPassAst = function(colorClosureSignatures){
        var lightPassAst;
        try{
            lightPassAst = parser.parse(Template.toString(), { raw: true });
        }
        catch(e){
            console.error("Error in parsing of lightPass template", e);
            return null;
        }
        var functionBlock = lightPassAst.body[0].body;
        //functionBlock.body.push(getInputArgDeclaration(colorClosureSignatures));

        var resolvedIfStatements = [];
        for(var i = 0; i < colorClosureSignatures.length; ++i){
            if(resolvedIfStatements.indexOf(colorClosureSignatures[i].id) == -1){
                resolvedIfStatements.push(colorClosureSignatures[i].id);
                functionBlock.body.push(getIfStatement(colorClosureSignatures[i]));
            }
        }

        return lightPassAst;
    }


    ns.generateLightPassAast = function(colorClosureSignatures, inject){
        var ast = ns.generateLightPassAst(colorClosureSignatures);
        if(!ast) return null;

        var opt = {};
        opt.entry = "global.shade";
        opt.validate = true;
        opt.throwOnError = true;
        opt.implementation = "xml3d-glsl-forward";
        opt.inject = inject;
        opt.lightLoopNoSpaceTransform = true;
        opt.lightLoopPositionArg = {type: Syntax.Identifier, name: "position"};
        opt.lightLoopAmbientArg = {type: Syntax.Identifier, name: "ambientIntensity"};
        var resultAast = analyzer.analyze(ast, {}, opt).ast;
        return resultAast;
    }

}(exports));

},{"../../analyze/analyze.js":52,"../../base/common.js":82,"../../resolve/xml3d-glsl-deferred/color-closure-signature.js":115,"./../../interfaces.js":111,"./light-pass-template":106,"esprima":41,"estraverse":42}],106:[function(require,module,exports){
(function (ns) {

    ns.LightPassTemplate = function shade(env){
        var texcoord = this.normalizedCoords.xy();
        var deferred0 = env.deferred0.sample2D(texcoord),
            deferred1 = env.deferred1.sample2D(texcoord),
            deferred2, deferred3, deferred4, deferred5, deferred6, deferred7;
        var ccId = deferred0.x();
        var position = deferred0.yzw();
        var ambientIntensity = deferred1.x();
    };

}(exports));

},{}],107:[function(require,module,exports){
(function (ns) {

    var common = require("../../base/common.js"),
        Shade = require("./../../interfaces.js"),
        Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS,
        SpaceType = Shade.SpaceType,
        VectorType = Shade.VectorType;
    var walk = require('estraverse');
    var Syntax = walk.Syntax;
    var ANNO = common.ANNO;


    ns.getSpaceTransformCall = function(ast, space){
        var callExpression = {
            type: Syntax.CallExpression,
            callee: this.getSpaceConvertFunction(space),
            arguments: [ this.getSpaceConvertArg(space), ast ]
        };
        return callExpression;
    };

    ns.getSpaceConvertFunction = function(space){
        var vectorType = Shade.getVectorFromSpaceVector(space);
        var functionName;
        switch(vectorType){
            case VectorType.POINT: functionName = "transformPoint"; break;
            case VectorType.NORMAL: functionName = "transformDirection"; break;
        }
        var result = {
            type: Syntax.MemberExpression,
            object: {type: Syntax.Identifier, name: "Space"},
            property: { type: Syntax.Identifier, name: functionName }
        };
        ANNO(result).setType(Types.FUNCTION);
        ANNO(result.object).setType(Types.OBJECT, Kinds.ANY);
        return result;
    }

    ns.getSpaceConvertArg = function(space){
        var spaceType = Shade.getSpaceFromSpaceVector(space);
        var spaceName;
        switch(spaceType){
            case SpaceType.VIEW: spaceName = "VIEW"; break;
            case SpaceType.WORLD: spaceName = "WORLD"; break;
        }
        return {
            type: Syntax.MemberExpression,
            object: { type: Syntax.Identifier, name: "Space"  },
            property: { type: Syntax.Identifier, name: spaceName }
        };
    };


}(exports));

},{"../../base/common.js":82,"./../../interfaces.js":111,"estraverse":42}],108:[function(require,module,exports){
(function (ns) {

    var Base = require("../../base/index.js"),
        common = require("../../base/common.js"),
        FunctionAnnotation = require("../../base/annotation.js").FunctionAnnotation,
        TypeInfo = require("../../base/typeinfo.js").TypeInfo,
        Shade = require("./../../interfaces.js"),
        esgraph = require('esgraph'),
        Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS;
    var spaceAnalyzer = require("../../analyze/space_analyzer.js"),
        SpaceVectorType = Shade.SpaceVectorType,
        SpaceType = Shade.SpaceType,
        VectorType = Shade.VectorType;
    var SpaceTransformTools = require("./space-transform-tools.js");



    var walk = require('estraverse');
    var Syntax = walk.Syntax;
    var ANNO = common.ANNO;


    /**
     * Transforms the JS AST to an AST representation convenient
     * for code generation
     * @constructor
     */
    var SpaceTransformer = function (mainId) {
        this.mainId = mainId;
    };

    function spaceInfo(ast){
        return ast.spaceInfo || {};
    }

    Base.extend(SpaceTransformer.prototype, {
        transformAast: function (aast, opt) {
            opt = opt || {};
            this.root = aast;
            this.functionSpaceInfo = {};
            this.functionTranfserInfo = {};
            this.globalIdentifiers = this.getGlobalIdentifiers(aast);
            this.envSpaces = {};

            this.transformFunctions(aast);
            this.updateGlobalObject(aast, this.envSpaces);
            return this.envSpaces;
        },
        /**
         *
         * @param {Object!} ast
         * @param {Object!} state
         * @returns {*}
         */
        transformFunctions: function(aast) {
            var self = this;
            aast = walk.replace(aast, {
                enter: function (node, parent) {
                    //console.log("Enter:", node.type);
                    switch (node.type) {
                        case Syntax.FunctionDeclaration:
                            self.replaceFunctionInvocations(node.body);
                            self.extractSpaceTransforms(node);
                            this.skip();
                            break;
                    }
                }
            });
            return aast;
        },
        replaceFunctionInvocations: function(functionBodyAast){
            var self = this;
            walk.replace(functionBodyAast, {
                enter: function (node, parent) {
                    if(node.type == Syntax.CallExpression){
                        if(node.callee.type == Syntax.Identifier && self.functionSpaceInfo[node.callee.name]){
                            var paramTransitions = self.functionSpaceInfo[node.callee.name];
                            var oldArgs = node.arguments, newArgs = [];
                            for(var i = 0; i < paramTransitions.length; ++i){
                                var paramT = paramTransitions[i];
                                if(!paramT.space)
                                    oldArgs[paramT.idx] !== undefined && newArgs.push(oldArgs[paramT.idx]);
                                else{
                                    newArgs.push(SpaceTransformTools.getSpaceTransformCall(oldArgs[paramT.idx], paramT.space));
                                }
                            }
                            node.arguments = newArgs;
                        }
                    }
                }
            });
        },

        extractSpaceTransforms: function(functionAast){
            var self = this;
            this.usedIdentifiers = this.getUsedIdentifiers(functionAast);

            var analyzeResult = spaceAnalyzer.analyze(functionAast, this.functionTranfserInfo);
            var nameMap = {}, addDeclarations = [];
            this.extractEnvSpaces(analyzeResult, nameMap);
            this.initFunctionHeader(functionAast, analyzeResult, nameMap, addDeclarations);

            functionAast.body = walk.replace(functionAast.body, {
                enter: function (node, parent) {
                    //console.log("Enter:", node.type);
                    if(node.type == Syntax.ExpressionStatement){
                        var newStatement = self.duplicateSpaceStatement(node, nameMap, addDeclarations);
                        if(newStatement){
                            this.skip();
                            return newStatement;
                        }
                    }
                    else if(spaceInfo(node).hasSpaceOverrides){
                        self.resolveSpaceUsage(node, SpaceVectorType.OBJECT, nameMap);
                        this.skip();
                    }
                }
            });
            this.addDeclarations(functionAast, addDeclarations);
            this.cleanUpDeclarations(functionAast);
        },

        extractEnvSpaces: function(analyzeResult, nameMap){
            for(var name in analyzeResult){
                if(name.indexOf("env.") == 0){
                    var property = name.substr(4);
                    var j = analyzeResult[name].length;
                    while(j--){
                        var space = analyzeResult[name][j];
                        var spaceName = this.getSpaceName(name, space);
                        if(!this.envSpaces[property]) this.envSpaces[property] = [];
                        if( !this.envSpaces[property].some(function(e){return e.space == space}))
                            this.envSpaces[property].push({ name: spaceName.split(".")[1], space: space } );
                        if(!nameMap[name]) nameMap[name] = {};
                        nameMap[name][space] = this.getSpaceName(name, space);
                    }
                }
            }
        },

        initFunctionHeader: function(functionAast, analyzeResult, nameMap, addDeclarations){
            var newParams = [];
            var paramTransitions = [];
            for(var i = 0; i < functionAast.params.length; ++i){
                var param = functionAast.params[i], paramName = param.name;
                if(analyzeResult[paramName]){
                    var j = analyzeResult[paramName].length, hasObjectSpace = false;
                    while(j--){
                        var space = analyzeResult[paramName][j];
                        if(space != SpaceVectorType.OBJECT){
                            if(!nameMap[paramName]) nameMap[paramName] = {};
                            nameMap[paramName][space] = this.getSpaceName(paramName, space);
                            var newParam = {
                                type: Syntax.Identifier,
                                name: nameMap[paramName][space]
                            };
                            ANNO(newParam).copy(ANNO(param));
                            newParams.push(newParam);
                            paramTransitions.push({idx: i, space: space});
                        }
                        else{
                            hasObjectSpace = true;
                            newParams.push(param);
                            paramTransitions.push({idx: i});
                        }
                    }
                    if(!hasObjectSpace){
                        addDeclarations.push(paramName);
                    }
                }
                else{
                    newParams.push(param);
                    paramTransitions.push({idx: i});
                }
            }
            functionAast.params = newParams;
            this.functionSpaceInfo[functionAast.id.name] = paramTransitions;
        },

        duplicateSpaceStatement: function(statementAast, nameMap, addedDeclarations){
            var duplicatedStatements = [];
            var child = statementAast.expression;
            var sInfo = spaceInfo(child);

            var newSpaceNameEntries = {};
            if(!sInfo.finalSpaces){
                nameMap[sInfo.def] = newSpaceNameEntries;
                return;
            }

            sInfo.finalSpaces.forEach(function(space){
                var expressionCopy = JSON.parse(JSON.stringify(child));
                if(space != SpaceVectorType.OBJECT && !this.isSpacePropagrationPossible(sInfo, space)){
                    this.resolveSpaceUsage(expressionCopy, SpaceVectorType.OBJECT, nameMap);
                    expressionCopy.right = SpaceTransformTools.getSpaceTransformCall(expressionCopy.right, space);
                }
                else{
                    this.resolveSpaceUsage(expressionCopy, space, nameMap);
                }
                duplicatedStatements.push({ type: Syntax.ExpressionStatement, expression: expressionCopy });
                if(space != SpaceVectorType.OBJECT){
                    var spaceName = this.getSpaceName(sInfo.def, space);
                    if(addedDeclarations.indexOf(spaceName) == -1)
                        addedDeclarations.push(spaceName);
                    newSpaceNameEntries[space] = spaceName;
                    expressionCopy.left.name = spaceName;
                }

            }.bind(this));
            nameMap[sInfo.def] = newSpaceNameEntries;

            if(duplicatedStatements.length == 0)
                return;
            if(duplicatedStatements.length == 1)
                return duplicatedStatements[0];

            var blockStatement = {
                type: Syntax.BlockStatement,
                body: duplicatedStatements
            };
            return blockStatement

        },

        addDeclarations: function(functionAast, addDeclarations){
            var i = functionAast.params.length;
            while(i--) {
                var idx = addDeclarations.indexOf(functionAast.params[i].name);
                if(idx != -1)
                    addDeclarations.splice(idx, 1);
            }
            if(addDeclarations.length > 0){
                var declarations = { type: Syntax.VariableDeclaration, kind: "var", declarations: []};
                var i = addDeclarations.length;
                while(i--){
                    var name = addDeclarations[i];
                    var decl = {type: Syntax.VariableDeclarator, id: {type: Syntax.Identifier, name: name}, init: null};
                    ANNO(decl).setType(Types.OBJECT, Kinds.FLOAT3);
                    declarations.declarations.push(decl);
                }
                functionAast.body.body.unshift(declarations);
            }
        },

        isSpacePropagrationPossible: function(sInfo, targetSpace){
            if(sInfo.propagateSet.length == 0) // We need to have at least one dependency. Otherwise we can't propagate the space
                return false;
            var vectorType = Shade.getVectorFromSpaceVector(targetSpace)
            if(vectorType == VectorType.NORMAL && sInfo.normalSpaceViolation)
                return false;
            if(vectorType == VectorType.POINT && sInfo.pointSpaceViolation)
                return false;

            return true;
        },

        resolveSpaceUsage: function(aast, targetSpace, nameMap){
            var self = this;
            aast = walk.replace(aast, {
                enter: function (node, parent) {
                    //console.log("Enter:", node.type);
                    switch (node.type) {
                        case Syntax.Identifier:
                            if(targetSpace != SpaceVectorType.OBJECT && spaceInfo(node).propagate){
                                node.name = nameMap[node.name][targetSpace];
                            }
                            break;
                        case Syntax.MemberExpression:
                            if(targetSpace != SpaceVectorType.OBJECT && spaceInfo(node).propagate){
                                var nameKey = "env." + node.property.name;
                                var name = nameMap[nameKey][targetSpace],
                                    token = name.split(".");
                                node.property.name = token[1];
                            }
                            break;
                        case Syntax.CallExpression:
                            var sInfo = spaceInfo(node);
                            if(sInfo.spaceOverride &&
                                self.isSpacePropagrationPossible(sInfo, sInfo.spaceOverride))
                            {
                                var result = self.resolveSpaceUsage(node.arguments[1], sInfo.spaceOverride, nameMap);
                                this.skip();
                                return result;
                            }
                    }
                }
            });
            return aast;
        },

        getSpaceName: function(name, space){
            if(space == SpaceVectorType.OBJECT)
                return name;

            var checkGlobal = false;
            if(name.indexOf("env.") == 0){
                checkGlobal = true;
                name = name.substr(4);
            }
            switch(space){
                case SpaceVectorType.VIEW_POINT : name += "_vps"; break;
                case SpaceVectorType.WORLD_POINT : name += "_wps"; break;
                case SpaceVectorType.VIEW_NORMAL : name += "_vns"; break;
                case SpaceVectorType.WORLD_NORMAL : name += "_wns"; break;
            }
            var result = name;
            var i = 2;
            while( (checkGlobal ? this.globalIdentifiers : this.usedIdentifiers ).indexOf(result) != -1){
                result = name + i++;
            }
            if(checkGlobal)
                result = "env." + result;
            return result;
        },

        getUsedIdentifiers : function(functionAast){
            var result = [];
            walk.traverse(functionAast, {
                enter: function (node, parent) {
                    //console.log("Enter:", node.type);
                    if(node.type == Syntax.Identifier){
                        if( parent.type == Syntax.MemberExpression && parent.property == node)
                            return;
                        if(result.indexOf(node.name) == -1)
                            result.push(node.name);
                    }
                }
            });
            return result;
        },
        getGlobalIdentifiers : function(programAast){
            var result = [];
            walk.traverse(programAast, {
                enter: function (node, parent) {
                    //console.log("Enter:", node.type);
                    if(node.type == Syntax.MemberExpression && node.object.extra.global){
                        if(result.indexOf(node.property.name) == -1)
                            result.push(node.property.name);
                    }
                }
            });
            return result;
        },
        cleanUpDeclarations: function(functionAast){
            var declarators = [];
            var body = functionAast.body.body;
            var i = body.length;
            while(i--){
                if(body[i].type == Syntax.VariableDeclaration){
                    declarators.push.apply(declarators, body[i].declarations);
                    body.splice(i,1);
                }
            }
            var usedIdentifiers = this.getUsedIdentifiers(functionAast.body);
            var declaration = { type: Syntax.VariableDeclaration, kind: "var", declarations: []};
            i = declarators.length;
            while(i--){
                if(usedIdentifiers.indexOf(declarators[i].id.name) != -1){
                    declaration.declarations.push(declarators[i]);
                }
            }
            if(declaration.declarations.length > 0)
                body.unshift(declaration);
        },

        updateGlobalObject: function(aast, envSpaces){
            if(!aast.globalParameters)
                return;
            var globalObject;
            for(var funcName in aast.globalParameters){
                var args = aast.globalParameters[funcName];
                var i = args.length;
                while(i--){
                    if(args[i].extra.global)
                        globalObject = args[i].extra;
                }
            }
            if(!globalObject)
                return;
            var newInfo = {};
            for(var propName in globalObject.info){
                var data = globalObject.info[propName];
                if(!envSpaces[propName]){
                    newInfo[propName] = data;
                    continue;
                }
                var entryList = envSpaces[propName];
                for(var i = 0; i < entryList.length; ++i){
                    var copyData = Base.deepExtend({}, data);
                    newInfo[entryList[i].name]= copyData;
                }
            }
            globalObject.info = newInfo;
            walk.traverse(aast, {
                enter: function (node, parent) {
                    //console.log("Enter:", node.type);
                    if(node.extra && node.extra.global){
                        node.extra.info = newInfo;
                    }
                    if(node.scope && node.scope.bindings){
                        for(var name in node.scope.bindings){
                            if(node.scope.bindings[name].extra.global){
                                node.scope.bindings[name].extra.info = newInfo;
                            }
                        }
                    }
                }
            });
        }


    });

    // Exports
    ns.SpaceTransformer = new SpaceTransformer();


}(exports));

},{"../../analyze/space_analyzer.js":59,"../../base/annotation.js":80,"../../base/common.js":82,"../../base/index.js":85,"../../base/typeinfo.js":87,"./../../interfaces.js":111,"./space-transform-tools.js":107,"esgraph":26,"estraverse":42}],109:[function(require,module,exports){
(function (ns) {

    var Syntax = require('estraverse').Syntax;
    var Base = require("../base/index.js");
    var ANNO = require("../base/annotation.js").ANNO;
    var TypeInfo = require("../base/typeinfo.js").TypeInfo;
    var Shade = require("../interfaces.js");
    var VecBase = require("../base/vec.js");

    var TYPES = Shade.TYPES,
        KINDS = Shade.OBJECT_KINDS;



    ns.removeMemberFromExpression = function (node) {
        return {
            type: Syntax.Identifier,
            name: node.property.name
        }
    }

    ns.generateFreeName = function(name, blockedNames){
        var newName = name.replace(/_+/g, "_"), i = 1;
        while(blockedNames.indexOf(newName) != -1){
            newName = (name + "_" + (++i)).replace(/_+/g, "_");
        }
        blockedNames.push(newName);
        return newName;
    }

    ns.getInternalFunctionName = function(state, key, type, details){
        if(!state.internalFunctions[key]){
            var name = ns.generateFreeName(key, state.blockedNames);
            state.internalFunctions[key] = {
                name: name,
                type: type,
                details: details
            };
        }
        return state.internalFunctions[key].name;
    };


    ns.binaryExpression2FunctionCall = function(node, name) {
        node.right = ns.castToFloat(node.right);
        node.left = ns.castToFloat(node.left);
        return {
            type: Syntax.CallExpression,
            callee: {
                type: Syntax.Identifier,
                name: name
            },
            arguments: [
                node.left,
                node.right
            ],
            extra: {
                type: TYPES.NUMBER
            }
        }
    };

    var Vec = {
        getVecArgs: function(args){
            if(args.length == 0){
                var result = [
                    {
                        type: "Literal",
                        value: "0"
                    }
                ];
                ANNO(result[0]).setType(TYPES.NUMBER);
                return result;
            }
            else{
                return args;
            }
        },

        generateVecFromArgs: function(vecCount, args){
            if(vecCount == 1)
                return args[0];
            if(args.length == 0){
                args = Vec.getVecArgs(args);
            }

            if(args.length == 1 && ANNO(args[0]).isOfKind(KINDS['FLOAT' + vecCount]))
                return args[0];
            var result = {
                type: Syntax.NewExpression,
                callee: {
                    type: Syntax.Identifier,
                    name: "Vec" + vecCount
                },
                arguments: args
            };
            ANNO(result).setType(TYPES.OBJECT, KINDS['FLOAT' + vecCount]);
            ANNO(result.callee).setType(TYPES.FUNCTION);
            return result;
        },

        createSwizzle: function(vecCount, swizzle, node, args, parent){
            if (args.length == 0) {
                node.callee.extra = node.extra;
                return node.callee;
            }
            var singular = swizzle.length == 1;
            var argObject = singular ? node.arguments[0] : Vec.generateVecFromArgs(swizzle.length, node.arguments);
            var replace = {
                type: Syntax.NewExpression,
                callee: {
                   type: Syntax.Identifier,
                   name: "Vec" + vecCount
                },
                arguments: []
            };
            var indices = [];
            for(var i = 0; i < swizzle.length; ++i){
                var idx = VecBase.swizzleToIndex(swizzle.charAt(i));
                indices[idx] = i;
            }
            for(var i = 0; i < vecCount; ++i){
                if(indices[i] !== undefined){
                    replace.arguments[i] = singular ? argObject : {
                        type: Syntax.MemberExpression,
                        object: argObject,
                        property: {
                            type: Syntax.Identifier,
                            name: VecBase.indexToSwizzle(indices[i])
                        }
                    };
                }
                else{
                   replace.arguments[i] = {
                        type: Syntax.MemberExpression,
                        object: node.callee.object,
                        property: {
                            type: Syntax.Identifier,
                            name: VecBase.indexToSwizzle(i)
                        }
                    };
                }
            }
            ANNO(replace).copy(ANNO(node));
            return replace;
        },
        createSwizzleOperator: function(vecCount, swizzle, operator, node, args, parent){
            var singular = swizzle.length == 1;
            var argObject = singular ? node.arguments[0] : Vec.generateVecFromArgs(swizzle.length, node.arguments);
            var replace = {
                type: Syntax.NewExpression,
                callee: {
                   type: Syntax.Identifier,
                   name: "Vec" + vecCount
                },
                arguments: []
            };
            var indices = [];
            for(var i = 0; i < swizzle.length; ++i){
                var idx = VecBase.swizzleToIndex(swizzle.charAt(i));
                indices[idx] = i;
            }
            for(var i = 0; i < vecCount; ++i){
                var thisValue = {
                    type: Syntax.MemberExpression,
                    object: node.callee.object,
                    property: {
                        type: Syntax.Identifier,
                        name: VecBase.indexToSwizzle(i)
                    }
                };
                if(indices[i] !== undefined){
                    replace.arguments[i] = {
                        type: Syntax.BinaryExpression,
                        operator: operator,
                        left: thisValue,
                        right: singular ? argObject : {
                            type: Syntax.MemberExpression,
                            object: argObject,
                            property: {
                                type: Syntax.Identifier,
                                name: VecBase.indexToSwizzle(indices[i])
                            }
                        }
                    }
                }
                else{
                   replace.arguments[i] = thisValue
                }
            }
            ANNO(replace).copy(ANNO(node));
            return replace;
        },

        attachSwizzles: function (instance, vecCount, callExp, callOperatorExp){
            for(var s = 0; s < VecBase.swizzleSets.length; ++s){
                for(var count = 1; count <= 4; ++count){
                    var max = Math.pow(vecCount, count);
                     for(var i = 0; i < max; ++i){
                        var val = i;
                        var key = "";
                        var indices = [], withSetter = (count <= vecCount);
                        for(var  j = 0; j < count; ++j){
                            var idx = val % vecCount;
                            val = Math.floor(val / vecCount);
                            key+= VecBase.swizzleSets[s][idx];
                            if(indices[idx])
                                withSetter = false;
                            else
                                indices[idx] = true;
                        }
                        instance[key] = {
                            callExp: callExp.bind(null, vecCount, key)
                        };
                        if(withSetter && callOperatorExp){
                            for(var operator in VecBase.swizzleOperators){
                                var opSymbol = VecBase.swizzleOperators[operator];
                                instance[key + operator] = {
                                    callExp: callOperatorExp.bind(null, vecCount, key, opSymbol)
                                };
                            }
                        }
                    }
                }
            }
        },

        createOperator: function(vecCount, operator, node, args, parent) {
            var other = Vec.generateVecFromArgs(vecCount, node.arguments);
            var replace = {
                type: Syntax.BinaryExpression,
                operator: operator,
                left: node.callee.object,
                right: other
            };
            ANNO(replace).copy(ANNO(node));
            return replace;
        },

        attachOperators: function(instance, vecCount, operators){
            for(var name in operators){
                var operator = operators[name];
                instance[name] = {
                    callExp: Vec.createOperator.bind(null, vecCount, operator)
                }
            }
        },

        createFunctionCall: function(functionName, secondVecSize, node, args, parent) {
            var replace = {
                type: Syntax.CallExpression,
                callee: {
                    type: Syntax.Identifier,
                    name: functionName
                },
                arguments: [
                    node.callee.object
                ]
            };
            if(secondVecSize){
                var other = Vec.generateVecFromArgs(secondVecSize, node.arguments);
                replace.arguments.push(other);
            }
            ANNO(replace).copy(ANNO(node));
            return replace;
        },

        generateLengthCall: function(node, args, parent){
            if(args.length == 0){
                return Vec.createFunctionCall('length', 0, node, args, parent);
            }
            else{
                 var replace = {
                    type: Syntax.BinaryExpression,
                    operator: '*',
                    left: node.callee.object,
                    right: {
                        type: Syntax.BinaryExpression,
                        operator: '/',
                        left: node.arguments[0],
                        right: Vec.createFunctionCall('length', 0, node, args, parent)
                    }
                };
                ANNO(replace.right).setType(TYPES.NUMBER);
                ANNO(replace).copy(ANNO(node));
                return replace;
            }
        },

        generateConstructor: function(node){
            node.arguments = Vec.getVecArgs(node.arguments);
        }
    };

    var Mat = {
        TYPES: {
            "Mat3" : {kind: KINDS.MATRIX3, colKind: KINDS.FLOAT3, colCount: 3, glslType: "mat3"},
            "Mat4" : {kind: KINDS.MATRIX4, colKind: KINDS.FLOAT4, colCount: 4, glslType: "mat3"}
        },

        generateMatFromArgs: function(matName, args){
            if(args.length == 0){
                args = Vec.getVecArgs(args);
            }

            if(args.length == 1 && ANNO(args[0]).isOfKind( Mat.TYPES[matName].kind))
                return args[0];
            var result = {
                type: Syntax.NewExpression,
                callee: {
                    type: Syntax.Identifier,
                    name: matName
                },
                arguments: args
            };
            ANNO(result).setType(TYPES.OBJECT, Mat.TYPES[matName].kind);
            ANNO(result.callee).setType(TYPES.FUNCTION);
            return result;
        },

        createOperator: function(matName, operator, node, args, parent) {
            var other = Mat.generateMatFromArgs(matName, node.arguments);
            var replace = {
                type: Syntax.BinaryExpression,
                operator: operator,
                left: node.callee.object,
                right: other
            };
            ANNO(replace).copy(ANNO(node));
            return replace;
        },

        attachOperators: function(instance, matName, operators){
            for(var name in operators){
                var operator = operators[name];
                instance[name] = {
                    callExp: Mat.createOperator.bind(null, matName, operator)
                }
            }
        },

        generateColCall: function(matName, node, args, parent, state){
            var memberAccess = {
                type: Syntax.MemberExpression,
                object: node.callee.object,
                property: node.arguments[0],
                computed: true
            };
            ANNO(memberAccess).setType(TYPES.OBJECT, Mat.TYPES[matName].colKind);

            if(args.length == 1){
                return memberAccess;
            }
            else{
                var methodKey = "_" + matName + "_col";
                var methodName = ns.getInternalFunctionName(state, methodKey,
                    "MatCol", {colType: "vec" + Mat.TYPES[matName].colCount, matType: Mat.TYPES[matName].glslType});

                 var replace = {
                    type: Syntax.CallExpression,
                    callee: {type: Syntax.Identifier, name: methodName},
                    arguments: [
                        node.callee.object,
                        node.arguments[0],
                        node.arguments[1]
                    ]
                };
                ANNO(replace).copy(ANNO(node));
                return replace;
            }
        }

    }


    ns.Vec = Vec;
    ns.Mat = Mat;

    ns.castToFloat = function (ast) {
        var exp = ANNO(ast);

        if (!exp.isNumber()) {   // Cast
            return {
                type: Syntax.CallExpression,
                callee: {
                    type: Syntax.Identifier,
                    name: "float"
                },
                arguments: [ast]
            }
        }
        return ast;
    }

    ns.getNameForSystem = function(baseName) {
        return baseName;
    }

    ns.getNameForGlobal = function(baseName) {
        var name = "_env_" + baseName;
        return name.replace(/_+/g, "_");
    }

    /**
     * @param {Object} node
     * @param  {GLTransformContext} context
     * @returns {*}
     */
    ns.castToVec4 = function (node, context) {
        var exp = TypeInfo.createForContext(node, context);

        if (exp.isOfKind(KINDS.FLOAT4) || exp.isOfKind(KINDS.COLOR_CLOSURE))
            return node;

        if (exp.isOfKind(KINDS.FLOAT3)) {
            return {
                type: Syntax.CallExpression,
                callee: {
                    type: Syntax.Identifier,
                    name: "vec4"
                },
                arguments: [node, { type: Syntax.Literal, value: 1.0, extra: { type: TYPES.NUMBER} }]
            }
        }
        Shade.throwError(node, "Can't cast from '" + exp.getTypeString() + "' to vec4");
    }

    ns.extend = Base.extend;
    ns.createClass = Base.createClass;

}(exports))

},{"../base/annotation.js":80,"../base/index.js":85,"../base/typeinfo.js":87,"../base/vec.js":88,"../interfaces.js":111,"estraverse":42}],110:[function(require,module,exports){
(function (ns) {
    var parser = require('esprima'),
        codegen = require('escodegen'),
        parameters = require("./analyze/parameters.js"),
        interfaces = require("./interfaces.js"),
        inference = require("./analyze/typeinference/typeinference.js"),
        sanitizer = require("./analyze/sanitizer/sanitizer.js"),
        Base = require("./base/index.js"),
        GLSLCompiler = require("./generate/glsl/compiler.js").GLSLCompiler,
        LightPassGenerator = require("./generate/light-pass/light-pass-generator.js"),
        resolver = require("./resolve/resolve.js"),
        SpaceTransformer = require("./generate/space/transform.js").SpaceTransformer,
        validator = require("./analyze/validator.js"),
        analyzer = require("./analyze/analyze.js"),
        SpaceVectorType = interfaces.SpaceVectorType,
        SpaceType = interfaces.SpaceType,
        VectorType = interfaces.VectorType;


    var WorkingSet = function(){
        this.ast = null;
        this.aast = null;
        this.result = null;
        this.processingData = {};
    };
    Base.extend(WorkingSet.prototype, {
        setAst: function(ast){
            this.ast = ast;
        },
        parse: function(code, opt){
            opt = opt || {};
            this.ast = ns.parse(code, opt);
        },
        analyze: function(inject, implementation, opt){
            opt = opt || {};
            opt.entry = opt.entry || "global.shade";
            opt.validate = opt.validate !== undefined ? opt.validate : true;
            opt.throwOnError = opt.throwOnError !== undefined ? opt.throwOnError : true;
            opt.implementation = implementation;
            opt.inject = inject;
            this.aast = analyzer.analyze(this.ast, this.processingData, opt).ast;
            return this.aast;
        },
        getProcessingData: function(key){
            return this.processingData[key];
        },
        compileFragmentShader: function(opt){
            this.result = ns.compileFragmentShader(this.aast, opt);
            return this.result;
        }
    });



    Base.extend(ns, {

        parse: function(ast, opt) {
            if (typeof ast == 'string') {
                return parser.parse(ast, {raw: true, loc: opt.loc || false });
            }
            return ast;
        },

        /**
         * Analyze the given source and extract all used shader and system parameters
         *
         * @param {function|string} input The function of source code to analyze
         * @param opt Options
         * @returns {{shaderParameters: Array, systemParameters: Array}}
         */
        extractParameters: function (input, opt) {
            if (typeof input == 'function') {
                input = input.toString();
            }
            var ast = parser.parse(input);
            return parameters.extractParameters(ast, opt);
        },

        getSanitizedAst: function(str, opt){
            var ast = parser.parse(str, {raw: true, loc: opt.loc || false });
            return sanitizer.sanitize(ast, opt);
        },

        parseAndInferenceExpression: function (ast, opt) {
            opt = opt || {};
            opt.entry = opt.entry || "global.shade";
            opt.validate = opt.validate !== undefined ? opt.validate : true;
            opt.throwOnError = opt.throwOnError !== undefined ? opt.throwOnError : true;

            ast = ns.parse(ast, opt);
            return analyzer.analyze(ast, {}, opt).ast;
        },

        analyze: function(ast, opt) {
            opt = opt || {};
            ast = ns.parse(ast, opt);

            return analyzer.analyze(ast, {}, opt)
        },

        resolveClosures: function(ast, implementation, processData, opt) {
            opt = opt || {};
            processData = processData || {};
            return resolver.resolveClosuresPreTypeInference(ast, implementation, processData, opt);
        },

        resolveSpaces: function(aast, opt){
            opt = opt || {};
            return SpaceTransformer.transformAast(aast, opt);
        },

        getLightPassAast: function(colorClosureSignatures, inject, opt){
            return LightPassGenerator.generateLightPassAast(colorClosureSignatures, inject)
        },

        compileFragmentShader: function(aast, opt){
            return new GLSLCompiler().compileFragmentShader(aast, opt);
        },

        toJavaScript: function(aast, opt){
            return codegen.generate(aast, opt);
        },

        TYPES : interfaces.TYPES,
        OBJECT_KINDS : interfaces.OBJECT_KINDS,
        SOURCES: interfaces.SOURCES,
        SPACE_VECTOR_TYPES: SpaceVectorType,
        Vec2: interfaces.Vec2,
        Vec3: interfaces.Vec3,
        Vec4: interfaces.Vec4,
        Texture: interfaces.Texture,
        Color: interfaces.Color,
        Mat3: interfaces.Mat3,
        Mat4: interfaces.Mat4,
        WorkingSet: WorkingSet

});
    /**
     * Library version:
     */
    ns.version = '0.0.1';

}(exports));

},{"./analyze/analyze.js":52,"./analyze/parameters.js":55,"./analyze/sanitizer/sanitizer.js":56,"./analyze/typeinference/typeinference.js":74,"./analyze/validator.js":79,"./base/index.js":85,"./generate/glsl/compiler.js":91,"./generate/light-pass/light-pass-generator.js":105,"./generate/space/transform.js":108,"./interfaces.js":111,"./resolve/resolve.js":114,"escodegen":9,"esprima":41}],111:[function(require,module,exports){
(function (ns) {
    var Base = require("./base/index.js");
    var CodeGen = require("escodegen");
    var VecMath = require("./base/vecmath.js").VecMath;


    /**
     * @enum {string}
     */
    var Types = ns.TYPES = {
        ANY: "any",
        INT: "int",
        NUMBER: "number",
        BOOLEAN: "boolean",
        OBJECT: "object",
        ARRAY: "array",
        NULL: "null",
        UNDEFINED: "undefined",
        FUNCTION: "function",
        STRING: "string",
        INVALID: "invalid"
    }

    var Kinds = ns.OBJECT_KINDS = {
        ANY: "any",
        FLOAT2: "float2", // virtual kinds
        FLOAT3: "float3", // virtual kinds
        FLOAT4: "float4", // virtual kinds
        NORMAL: "normal",
        MATRIX3: "matrix3",
        MATRIX4: "matrix4",
        TEXTURE: "texture",
        COLOR_CLOSURE: "color_closure"
    }

    var Semantics = ns.SEMANTICS = {
        COLOR: 'color',
        NORMAL: 'normal',
        SCALAR_0_TO_1: 'scalar0To1',
        UNKNOWN: 'unknown'
    }

    /**
     * Possible Spaces
     * @enum
     */
    var SpaceType = ns.SpaceType = {
        OBJECT: 0,
        VIEW: 1,
        WORLD: 2,
        RESULT: 5
    };
    var VectorType = ns.VectorType = {
        NONE: 0,
        POINT: 1,
        NORMAL: 2
    };
    ns.SpaceVectorType = {
        OBJECT: SpaceType.OBJECT,
        VIEW_POINT : SpaceType.VIEW + (VectorType.POINT << 3),
        WORLD_POINT : SpaceType.WORLD + (VectorType.POINT << 3),
        VIEW_NORMAL : SpaceType.VIEW + (VectorType.NORMAL << 3),
        WORLD_NORMAL : SpaceType.WORLD + (VectorType.NORMAL << 3),
        RESULT_POINT : SpaceType.RESULT + (VectorType.POINT << 3),
        RESULT_NORMAL : SpaceType.RESULT + (VectorType.NORMAL << 3)
    };
    ns.getVectorFromSpaceVector = function(spaceType){
        return spaceType >> 3;
    }
    ns.getSpaceFromSpaceVector = function(spaceType){
        return spaceType % 8;
    }

    ns.SOURCES = {
        UNIFORM: "uniform",
        VERTEX: "vertex",
        CONSTANT: "constant"
    }

    ns.ColorClosures = {
        "emissive" : {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.COLOR}
            ]
        },
        "diffuse" : {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.COLOR},
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0 }
            ]
        },
        "phong" : {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.COLOR},
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0}
            ]
        },
        cookTorrance: {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.COLOR},
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0.0},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0.0}
            ]
        },
        ward: {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.COLOR},
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0.0},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0.0}
            ]
        },
        scatter: {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.COLOR},
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 0}
            ]
        },
        "reflect" : {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 1 },
            ]
        },
        "refract" : {
            input: [
                { type: Types.OBJECT, kind: Kinds.FLOAT3, semantic: Semantics.NORMAL},
                { type: Types.NUMBER, semantic: Semantics.SCALAR_0_TO_1, defaultValue: 1 },
                { type: Types.NUMBER, semantic: Semantics.UNKNOWN, defaultValue: 1 },
            ]
        }
    }

    function isArray(v){
        return v instanceof Array ||
            v instanceof Float32Array ||
            v instanceof Float64Array ||
            v instanceof Int16Array ||
            v instanceof Int32Array ||
            v instanceof Int8Array;
    }


    function constructFromMatrix(dest, matSize, args){
        if(args.length > 1){
            for(var i = 0; i < args.length; ++i){
                if(args[i] instanceof Mat3 || args[i] instanceof Mat4 || args[i] instanceof Array)
                    throw "Constructing Matrix from Matrix can only take one argument";
            }
        }
        if(args.length < 1)
            return false;
        if(args.length == 1){
            var srcMat = args[0];
            var srcSize = 0;

            if(srcMat instanceof Mat3) srcSize = 3;
            else if(srcMat instanceof Mat4) srcSize = 4;
            else if(isArray(srcMat)) srcSize = srcMat.length == 16 ? 4 : 3;
            else return false;

            for(var y = 0; y < matSize; y++)
                for(var x = 0; x < matSize; x++){
                    var destIdx = y*matSize + x;
                    if(x < srcSize && y < srcSize){
                        var srcIdx = y*srcSize + x;
                        dest[destIdx] = srcMat[srcIdx];
                    }
                    else dest[destIdx] = x == y ? 1 : 0;
                }
            return true;
        }

    }

    function fillVector(dest, vecSize, arguments){
        var color = false;
        if(arguments.length == 0 ){
            for(var i = 0; i < vecSize; ++i)
                dest[i] = 0;
            if(color) dest[3] = 1;
            return;
        }
        if(arguments.length == 1 && !isNaN(arguments[0])){
            for(var i = 0; i < vecSize; ++i)
                dest[i] = arguments[0];
            if(color) dest[3] = 1;
            return;
        }

        var idx = 0;
        for(var i = 0; idx < vecSize && i < arguments.length; ++i){
            var arg= arguments[i], cnt = 0;

            if(!isNaN(arg)) cnt = 1;
            else if(arg instanceof Vec2) cnt = 2;
            else if(arg instanceof Vec3) cnt = 3;
            else if(arg instanceof Vec4) cnt = 4;
            else if(arg instanceof Mat3) cnt = 9;
            else if(arg instanceof Mat4) cnt = 16;
            else if(Array.isArray(arg) || (typeof arg === "object" && "BYTES_PER_ELEMENT" in arg)) cnt = arg.length;
            else return false;

            if(cnt == 1)
                dest[idx++] = arg || 0;
            else
                for(var j = 0; idx < vecSize && j < cnt; ++j){
                    dest[idx++] = arg[j];
                }
        }
        if(i < arguments.length)
            throw new Error("Too many arguments for " + (color ? "Color" : "Vec" + vecSize) + ".");
        if(idx < vecSize){
            if(color && (idx == 3))
                dest[3] = 1;
            else
                throw new Error("Not enough arguments for " + (color ? "Color" : "Vec" + vecSize) + ".");
        }
    }


    // TODO: Generate Swizzle functions
    var SWIZZLE_KEYS = [
        ['x','y','z','w'],
        ['r', 'g', 'b', 'a'],
        ['s', 't', 'p', 'q']
    ]

    function addSwizzles(prototype, vecCount, maskCount, withSetter){
        var max = Math.pow(vecCount, maskCount);
        for(var i = 0; i < max; ++i){
            var indices = [], keys = ["", "", ""], val = i, args = [];
            var setterArgs = [], generateSetter = withSetter;
            for(var j = 0; j < maskCount; ++j){
                var idx = val % vecCount;
                indices.push(idx);
                if(generateSetter){
                    if(setterArgs[idx] === undefined)
                        setterArgs[idx] = 'other[' + j + ']';
                    else
                        generateSetter = false;
                }
                for(var k = 0; k < SWIZZLE_KEYS.length; ++k){
                    keys[k] += SWIZZLE_KEYS[k][idx];
                }
                val = Math.floor(val / vecCount);
                args.push('this['+ idx + ']' );
            }

            var funcArgs = "";
            var body = '  return getVec' + maskCount + '(' + args.join(", ") +');\n';
            if(generateSetter){
                var assignSetters = [];
                for(var j = 0; j < vecCount; ++j){
                    if(setterArgs[j] === undefined)
                        assignSetters[j] = 'this[' + j + ']';
                    else
                        assignSetters[j] = setterArgs[j];
                }
                switch(maskCount){
                    case 2 : funcArgs = "x, y"; break;
                    case 3 : funcArgs = "x, y, z"; break;
                    case 4 : funcArgs = "x, y, z, w"; break;
                }

                body = "  if(arguments.length == 0)\n  " + body +
                       "  else{\n" +
                       "    var other=getVec" + maskCount + '.apply(null, arguments);\n' +
                       "    return getVec" + vecCount + '(' + assignSetters.join(", ") + ');\n' +
                       "  }\n";
            }
            var functionCode = 'function(' + funcArgs +  '){\n' + body + '}';
            try{
                var result = eval("(" + functionCode + ")");
                for(var j = 0; j < keys.length; ++j)
                    prototype[keys[j]] = result;
            }
            catch(e){
                console.error("Error Compiling Code:\n" + functionCode);
                throw e;
            }
            if(generateSetter){
                addSwizzleOperator(prototype, vecCount, maskCount, keys, "Add", "+", setterArgs);
                addSwizzleOperator(prototype, vecCount, maskCount, keys, "Sub", "-", setterArgs);
                addSwizzleOperator(prototype, vecCount, maskCount, keys, "Mul", "*", setterArgs);
                addSwizzleOperator(prototype, vecCount, maskCount, keys, "Div", "/", setterArgs);
            }
        }
    }
    function addSwizzleOperator(prototype, vecCount, maskCount, keys, methodName, operator, setterArgs){
        var assignSetters = [];
        for(var j = 0; j < vecCount; ++j){
            var prefix = 'this[' + j + ']';
            if(setterArgs[j] === undefined)
                assignSetters[j] = prefix;
            else
                assignSetters[j] = prefix + " " + operator + " " + setterArgs[j];
        }
        var body =  "   var other=getVec" + maskCount + '.apply(null, arguments);\n' +
                    "   return getVec" + vecCount + '(' + assignSetters.join(", ") + ');\n'

        var functionCode = 'function(){\n' + body + '}';
        try{
            var result = eval("(" + functionCode + ")");
            for(var j = 0; j < keys.length; ++j)
                prototype[keys[j] + methodName] = result;
        }
        catch(e){
            console.error("Error Compiling Code:\n" + functionCode);
            throw e;
        }
    }


    /**
    * The virtual Vec2 type
    * @constructor
    */
    var Vec2 = function(x, y) {
        fillVector(this, 2, arguments);
    }


    function getVec2() {
        if(arguments[0] instanceof Vec2)
            return arguments[0];
        var obj = new Vec2();
        Vec2.apply(obj, arguments);
        return obj;
    }

    Vec2.prototype._toFloatArray = function(){
        var res = new Float32Array(2);
        var i = 2; while(i--) res[i] = this[i];
        return res;
    }

    Vec2.prototype.add = function(x, y) { // 0 arguments => identity or error?
        var add = getVec2.apply(null, arguments);
        return new Vec2(this[0] + add[0], this[1] + add[1]);
    }
    Vec2.prototype.sub = function(x, y) {
        var sub = getVec2.apply(null, arguments);
        return new Vec2(this[0] - sub[0], this[1] - sub[1]);
    }
    Vec2.prototype.mul = function(x, y) {
        var other = getVec2.apply(null, arguments);
        return new Vec2(this[0] * other[0], this[1] * other[1]);
    }
    Vec2.prototype.div = function(x, y) {
        var other = getVec2.apply(null, arguments);
        return new Vec2(this[0] / other[0], this[1] / other[1]);
    }
    Vec2.prototype.mod = function(x, y) {
        var other = getVec2.apply(null, arguments);
        return new Vec2(this[0] % other[0], this[1] % other[1]);
    }
    Vec2.prototype.dot = function(x, y) {
        var other = getVec2.apply(null, arguments);
        return this[0] * other[0] + this[1] * other[1];
    }
    Vec2.prototype.abs = function() {
        return new Vec2(Math.abs(this[0]), Math.abs(this[1]));
    }
    Vec2.prototype.length = function(length) {
        if(arguments.length == 0)
            return Math.sqrt(this.dot(this));
        else {
            return this.mul(length / this.length());
        }
    }
    Vec2.prototype.normalize = function() {
        return this.length(1);
    }

    Vec2.prototype.xy = Vec2.prototype.rg = Vec2.prototype.st = function(x, y) {
        if(arguments.length == 0)
            return this;
        else {
            return getVec2.apply(null, arguments);
        }
    }
    Vec2.prototype.x = Vec2.prototype.r = Vec2.prototype.s = function(x) {
        if(arguments.length == 0)
            return this[0];
        else
            return this.xy(x, this[1]);
    }
    Vec2.prototype.y = Vec2.prototype.g = Vec2.prototype.t = function(y) {
        if(arguments.length == 0)
            return this[1];
        else
            return this.xy(this[0], y);
    }

    addSwizzles(Vec2.prototype, 2, 2, true);
    addSwizzles(Vec2.prototype, 2, 3, false);
    addSwizzles(Vec2.prototype, 2, 4, false);


    /**
     * The virtual Vec3 type
     * @constructor
     */
    var Vec3 = function(x, y, z) {
        fillVector(this, 3, arguments);
    }

    function getVec3() {
        if(arguments[0] instanceof Vec3)
            return arguments[0];
        var obj = new Vec3();
        Vec3.apply(obj, arguments);
        return obj;
    }

    Vec3.prototype._toFloatArray = function(){
        var res = new Float32Array(3);
        var i = 3; while(i--) res[i] = this[i];
        return res;
    }

    Vec3.prototype.add = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        return new Vec3(this[0] + other[0], this[1] + other[1], this[2] + other[2]);
    }
    Vec3.prototype.sub = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        return new Vec3(this[0] - other[0], this[1] - other[1], this[2] - other[2]);
    }
    Vec3.prototype.mul = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        return new Vec3(this[0] * other[0], this[1] * other[1], this[2] * other[2]);
    }
    Vec3.prototype.div = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        return new Vec3(this[0] / other[0], this[1] / other[1], this[2] / other[2]);
    }
    Vec3.prototype.mod = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        return new Vec3(this[0] % other[0], this[1] % other[1], this[2] % other[2]);
    }
    Vec3.prototype.abs = function() {
        return new Vec3(Math.abs(this[0]), Math.abs(this[1]), Math.abs(this[2]));
    }
    Vec3.prototype.dot = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        return this[0] * other[0] + this[1] * other[1] + this[2] * other[2];
    }
    Vec3.prototype.cross = function(x, y, z) {
        var other = getVec3.apply(null, arguments);
        var x = this[1] * other[2] - other[1] * this[2];
        var y = this[2] * other[0] - other[2] * this[0];
        var z = this[0] * other[1] - other[0] * this[1];
        return new Vec3(x, y, z);
    }
    Vec3.prototype.length = function(length) {
        if(arguments.length == 0)
            return Math.sqrt(this.dot(this));
        else {
            return this.mul(length / this.length());
        }
    }
    Vec3.prototype.normalize = function() {
        return this.length(1);
    }
    Vec3.prototype.xyz = Vec3.prototype.rgb = Vec3.prototype.stp = function(x, y, z) {
        if(arguments.length == 0)
            return this;
        else
            return new Vec3(x, y, z);
    }
    Vec3.prototype.x = Vec3.prototype.r = Vec3.prototype.s = function(x) {
        if(arguments.length == 0)
            return this[0];
        else
            return new Vec3(x, this[1], this[2]);
    }
    Vec3.prototype.y = Vec3.prototype.g = Vec3.prototype.t = function(y) {
        if(arguments.length == 0)
            return this[1];
        else
            return new Vec3(this[0], y, this[2]);
    }
    Vec3.prototype.z = Vec3.prototype.b = Vec3.prototype.p = function(z) {
        if(arguments.length == 0)
            return this[2];
        else
            return new Vec3(this[0], this[1], z);
    }
    addSwizzles(Vec3.prototype, 3, 2, true);
    addSwizzles(Vec3.prototype, 3, 3, true);
    addSwizzles(Vec3.prototype, 3, 4, false);


    /**
     * The virtual Vec4 type
     * @constructor
     */
    var Vec4 = function(x, y, z, w) {
        fillVector(this, 4, arguments)
    }

    function getVec4() {
        if(arguments[0] instanceof Vec4)
            return arguments[0];
        var obj = new Vec4();
        Vec4.apply(obj, arguments);
        return obj;
    }

    Vec4.prototype._toFloatArray = function(){
        var res = new Float32Array(4);
        var i = 4; while(i--) res[i] = this[i];
        return res;
    }

    Vec4.prototype.add = function(x, y, z, w) {
        var other = getVec4.apply(null, arguments);
        return new Vec4(this[0] + other[0], this[1] + other[1], this[2] + other[2], this[3] + other[3]);
    }
    Vec4.prototype.sub = function(x, y, z, w) {
        var other = getVec4.apply(null, arguments);
        return new Vec4(this[0] - other[0], this[1] - other[1], this[2] - other[2], this[3] - other[3]);
    }
    Vec4.prototype.mul = function(x, y, z, w) {
        var other = getVec4.apply(null, arguments);
        return new Vec4(this[0] * other[0], this[1] * other[1], this[2] * other[2], this[3] * other[3]);
    }
    Vec4.prototype.div = function(x, y, z, w) {
        var other = getVec4.apply(null, arguments);
        return new Vec4(this[0] / other[0], this[1] / other[1], this[2] / other[2], this[3] / other[3]);
    }
    Vec4.prototype.mod = function(x, y, z, w) {
        var other = getVec4.apply(null, arguments);
        return new Vec4(this[0] % other[0], this[1] % other[1], this[2] % other[2], this[3] % other[3]);
    }
    Vec4.prototype.abs = function() {
        return new Vec4(Math.abs(this[0]), Math.abs(this[1]), Math.abs(this[2]), Math.abs(this[3]));
    }
    Vec4.prototype.dot = function(x, y, z, w) {
        var other = getVec4.apply(null, arguments);
        return this[0] * other[0] + this[1] * other[1] + this[2] * other[2] + this[3] * other[3];
    }
    Vec4.prototype.length = function(length) {
        if(arguments.length == 0)
            return Math.sqrt(this.dot(this));
        else {
            return this.mul(length / this.length());
        }
    }
    Vec4.prototype.normalize = function() {
        return this.length(1);
    }
    Vec4.prototype.xyzw = Vec4.prototype.rgba = Vec4.prototype.stpq = function(x, y, z, w) {
        if(arguments.length == 0)
            return this;
        else
            return getVec4.apply(null, arguments);
    }
    Vec4.prototype.x = Vec4.prototype.r = Vec4.prototype.s = function(x) {
        if(arguments.length == 0)
            return this[0];
        else
            return getVec4(x, this[1], this[2], this[3]);
    }

    Vec4.prototype.y = Vec4.prototype.g = Vec4.prototype.t = function(y) {
        if(arguments.length == 0)
            return this[1];
        else
            return getVec4(this[0], y, this[2], this[3]);
    }
    Vec4.prototype.z = Vec4.prototype.b = Vec4.prototype.p = function(z) {
        if(arguments.length == 0)
            return this[2];
        else
            return getVec4(this[0], this[1], z, this[3]);
    }
    Vec4.prototype.w = Vec4.prototype.a = Vec4.prototype.q = function(w) {
        if(arguments.length == 0)
            return this[3];
        else
            return getVec4(this[0], this[1], this[2], w);
    }
    addSwizzles(Vec4.prototype, 4, 2, true);
    addSwizzles(Vec4.prototype, 4, 3, true);
    addSwizzles(Vec4.prototype, 4, 4, true);

    /**
     * The virtual Color type
     * @constructor
     */
    var Color = Vec4;

    /**
     * The virtual Mat3 type
     * @constructor
     */
    var Mat3 = function(m11, m12, m13, m21, m22, m23, m31, m32, m33) {
        constructFromMatrix(this, 3, arguments) || fillVector(this, 9, arguments)
    }

    function getMat3() {
        if(arguments[0] instanceof Mat3)
            return arguments[0];
        var obj = new Mat3();
        Mat3.apply(obj, arguments);
        return obj;
    }

    Mat3.prototype._toFloatArray = function(){
        var res = new Float32Array(9);
        var i = 9; while(i--) res[i] = this[i];
        return res;
    }

    Mat3.prototype.add = function(m11, m12, m13, m21, m22, m23, m31, m32, m33) {
        var other = getMat3.apply(null, arguments);
        return new Mat3(this[0] + other[0], this[1] + other[1], this[2] + other[2],
                        this[3] + other[3], this[4] + other[4], this[5] + other[5],
                        this[6] + other[6], this[7] + other[7], this[8] + other[8]);
    }
    Mat3.prototype.sub = function(m11, m12, m13, m21, m22, m23, m31, m32, m33) {
        var other = getMat3.apply(null, arguments);
        return new Mat3(this[0] - other[0], this[1] - other[1], this[2] - other[2],
                        this[3] - other[3], this[4] - other[4], this[5] - other[5],
                        this[6] - other[6], this[7] - other[7], this[8] - other[8]);
    }
    Mat3.prototype.mul = function(m11, m12, m13, m21, m22, m23, m31, m32, m33) {
        var other = getMat3.apply(null, arguments);
        // TODO: Do correct matrix multiplication...
        return null;
    }
    Mat3.prototype.div = function(m11, m12, m13, m21, m22, m23, m31, m32, m33) {
        var other = getMat3.apply(null, arguments);
        return new Mat3(this[0] / other[0], this[1] / other[1], this[2] / other[2],
                        this[3] / other[3], this[4] / other[4], this[5] / other[5],
                        this[6] / other[6], this[7] / other[7], this[8] / other[8]);
    }

    Mat3.prototype.col = function(idx, x, y, z){
        if(arguments.length == 1){
            return new Vec3(this[3*idx + 0], this[3*idx + 1], this[3*idx + 2]);
        }
        else{
            var input = getVec3.apply(null, Array.prototype.slice.call(arguments, 1));
            var copy = new Mat3(this);
            copy[3*idx + 0] = input[0];
            copy[3*idx + 1] = input[1];
            copy[3*idx + 2] = input[2];
        }
    }
    Mat3.prototype.mulVec = function(x, y, z){
        var other = getVec3.apply(null, arguments);
        return new Vec3(
            other.dot(this[0], this[1], this[2]),
            other.dot(this[3], this[4], this[5]),
            other.dot(this[6], this[7], this[8])
        )
    }

    /**
     * The virtual Mat3 type
     * @constructor
     */
    var Mat4 = function(m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44) {
        constructFromMatrix(this, 4, arguments) || fillVector(this, 16, arguments);
    }

    function getMat4() {
        if(arguments[0] instanceof Mat4)
            return arguments[0];
        var obj = new Mat4();
        Mat4.apply(obj, arguments);
        return obj;
    }

    Mat4.prototype._toFloatArray = function(){
        var res = new Float32Array(16);
        var i = 16; while(i--) res[i] = this[i];
        return res;
    }

    Mat4.prototype.add = function(m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44) {
        var other = getMat4.apply(null, arguments);
        return new Mat3(this[0] + other[0], this[1] + other[1], this[2] + other[2], this[3] + other[3],
                        this[4] + other[4], this[5] + other[5], this[6] + other[6], this[7] + other[7],
                        this[8] + other[8], this[9] + other[9], this[10] + other[10], this[11] + other[11],
                        this[12] + other[12], this[13] + other[13], this[14] + other[14], this[15] + other[15]);
    }
    Mat4.prototype.sub = function(m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44) {
        var other = getMat4.apply(null, arguments);
        return new Mat3(this[0] - other[0], this[1] - other[1], this[2] - other[2], this[3] - other[3],
                        this[4] - other[4], this[5] - other[5], this[6] - other[6], this[7] - other[7],
                        this[8] - other[8], this[9] - other[9], this[10] - other[10], this[11] - other[11],
                        this[12] - other[12], this[13] - other[13], this[14] - other[14], this[15] - other[15]);
    }
    Mat4.prototype.mul = function(m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44) {
        var other = getMat4.apply(null, arguments);
        // TODO: Do correct matrix multiplication...
        return null;
    }
    Mat4.prototype.div = function(m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44) {
        var other = getMat4.apply(null, arguments);
        return new Mat3(this[0] / other[0], this[1] / other[1], this[2] / other[2], this[3] / other[3],
                        this[4] / other[4], this[5] / other[5], this[6] / other[6], this[7] / other[7],
                        this[8] / other[8], this[9] / other[9], this[10] / other[10], this[11] / other[11],
                        this[12] / other[12], this[13] / other[13], this[14] / other[14], this[15] / other[15]);
    }

    Mat4.prototype.col = function(idx, x, y, z, w){
        if(arguments.length == 1){
            return new Vec4(this[4*idx + 0], this[4*idx + 1], this[4*idx + 2], this[4*idx + 3]);
        }
        else{
            var input = getVec4.apply(null, Array.prototype.slice.call(arguments, 1));
            var copy = new Mat4(this);
            copy[4*idx + 0] = input[0];
            copy[4*idx + 1] = input[1];
            copy[4*idx + 2] = input[2];
            copy[4*idx + 3] = input[3];
        }
    }
    Mat4.prototype.mulVec = function(x, y, z, w){
        var other = getVec4.apply(null, arguments);
        return new Vec4(
            other.dot(this[0], this[1], this[2], this[3]),
            other.dot(this[4], this[5], this[6], this[7]),
            other.dot(this[8], this[9], this[10], this[11]),
            other.dot(this[12], this[13], this[14], this[15])
        );
    }


    /**
     * The virtual Teture type
     * @constructor
     */
    var Texture = function(image) {
        this.image = image;
    }

    Texture.prototype.sample2D = function(x, y) {
        return new Vec4(0, 0, 0, 0);
    }





    var Shade = {};


    // Extensions of Math,
    // TODO: Implement for Vectors
    Math.clamp = function(x, minVal, maxVal) {
        return Math.min(Math.max(x, minVal), maxVal);
    };

    Math.smoothstep = function(edge1, edge2, x) {
        var t = Math.clamp((x - edge1) / (edge2 - edge1), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
    };

    Math.step = function(edge, x) {
        return x < edge ? 0 : 1;
    };

    Math.fract = function(x) {
        return x - Math.floor(x);
    };

    Math.mix = function(x,y,a) {
        var simple = typeof x == 'number';
        var asimple = typeof a == 'number';
        if(simple && asimple)
            return x*(1-a) + y*a;
        if (asimple)
            return x.mul(1-a).add(y.mul(a));
        return x.mul(a.mul(-1).add(1)).add(y.mul(a));
    }

    Math.saturate = function (x) {
        return Math.clamp(x, 0.0, 1.0);
    }



    /**
     * @param {object} node
     * @param {string} msg
     */
    ns.throwError = function(node, msg) {
        var loc = node && node.loc;
        if (loc && loc.start.line) {
            msg = "Line " + loc.start.line + ": " + msg;
        }
        msg += ": " + CodeGen.generate(node);



        var error = new Error(msg);
        error.loc = loc;
        throw error;
    }

    ns.toJavaScript = function(node) {
        return CodeGen.generate(node);
    };

    ns.Vec2 = Vec2;
    ns.Vec3 = Vec3;
    ns.Vec4 = Vec4;
    ns.Mat3 = Mat3;
    ns.Mat4 = Mat4;
    ns.Color = Color;
    ns.Shade = Shade;
    ns.VecMath = VecMath;

}(exports));

},{"./base/index.js":85,"./base/vecmath.js":89,"escodegen":9}],112:[function(require,module,exports){
(function (ns) {

    var Traversal = require('estraverse'),
        Syntax = Traversal.Syntax,
        parser = require('esprima'),
        Shade = require("../interfaces.js"),
        ANNO = require("./../base/annotation.js").ANNO;

    function handleCallExpression(node) {
        var callee = ANNO(node.callee);
        // console.log("Call", node.callee.property, callee.getTypeString(), node.callee.object)
        if(callee.isOfKind(Shade.OBJECT_KINDS.COLOR_CLOSURE)) {
            ANNO(node).copy(callee);
        }
    }

    function handleNewExpression(node) {
        if (node.callee.name == "Shade") {
            var result = ANNO(node);
            result.setType(Shade.TYPES.OBJECT, Shade.OBJECT_KINDS.COLOR_CLOSURE);
        }
    }

    function handleMemberExpression(node) {
        var object = ANNO(node.object);
        var result = ANNO(node);
        if (object.isOfKind(Shade.OBJECT_KINDS.COLOR_CLOSURE)) {
            var closureName = node.property.name;
            if (!Shade.ColorClosures.hasOwnProperty(closureName)) {
                console.error("No closure for name'", closureName, "'");
                return;
            };
            result.copy(object);
        }
    }

    ns.markColorClosures = function(programAast){
        Traversal.traverse(programAast, {
            leave: function(node, parent){
                 switch (node.type) {
                    case Syntax.CallExpression:
                        return handleCallExpression(node);
                    case Syntax.NewExpression:
                        return handleNewExpression(node);
                    case Syntax.MemberExpression:
                        return handleMemberExpression(node);
                }
            }
        });
    }

}(exports));

},{"../interfaces.js":111,"./../base/annotation.js":80,"esprima":41,"estraverse":42}],113:[function(require,module,exports){
(function (ns) {

    var Traversal = require('estraverse'),
        Syntax = Traversal.Syntax,
        parser = require('esprima');

    var Shade = require("../interfaces.js"),
    SpaceVectorType = Shade.SpaceVectorType,
    Types = Shade.TYPES,
    Kinds = Shade.OBJECT_KINDS;

    ns.getDefaultValue = function(ccInputDefinition){
        if(ccInputDefinition.defaultValue == undefined)
            throw new Error("ColorClosure input has not default value!");

        if(ccInputDefinition.type == Types.NUMBER || ccInputDefinition.type == Types.INT){
            var result = {
                type: Syntax.Literal,
                value: ccInputDefinition.defaultValue
            }
            return result;
        }
        else{
            throw new Error("Currentlty don't support default values of type " + ccInputDefinition.type + " and kind " + ccInputDefinition.kind);
        }
    }

}(exports));

},{"../interfaces.js":111,"esprima":41,"estraverse":42}],114:[function(require,module,exports){
(function (ns) {

    var ColorClosureMarker = require("./colorclosure-marker.js");

    var c_implementations = {};

    var registerLightingImplementation = ns.registerLightingImplementation = function (name, obj) {
        c_implementations[name] = obj;
    };

    ns.resolveClosuresPreTypeInference = function (aast, implementationName, processingData, opt) {
        if (!implementationName) {
            return aast;
        }
        try {
            var resolverImpl = c_implementations[implementationName];
            if (resolverImpl.resolvePreTypeInference) {
                ColorClosureMarker.markColorClosures(aast);
                return resolverImpl.resolvePreTypeInference(aast, processingData, opt);
            } else
                return aast;
        } catch (e) {
            console.error(e);
        }
        return aast;
    };

    ns.resolveClosuresPostTypeInference = function (aast, implementationName, processingData, opt) {
        if (!implementationName) {
            return aast;
        }
        try {
            var resolverImpl = c_implementations[implementationName];
            if (resolverImpl.resolvePostTypeInference)
                return resolverImpl.resolvePostTypeInference(aast, processingData, opt); else
                return aast;
        } catch (e) {
            console.error(e);
        }
        return aast;
    };

    registerLightingImplementation("xml3d-glsl-forward", require("./xml3d-glsl-forward"));
    registerLightingImplementation("xml3d-glsl-deferred", require("./xml3d-glsl-deferred"));

}(exports));

},{"./colorclosure-marker.js":112,"./xml3d-glsl-deferred":116,"./xml3d-glsl-forward":118}],115:[function(require,module,exports){
(function (ns) {

    var Base = require("../../base/index.js"),
        Traversal = require('estraverse'),
        Syntax = Traversal.Syntax,
        ANNO = require("./../../base/annotation.js").ANNO,
        DeferredInfo = require("./xml3d-deferred.js");

    var Shade = require("../../interfaces.js"),
        SpaceVectorType = Shade.SpaceVectorType,
        Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS;

    var SpaceTransformTools = require("../../generate/space/space-transform-tools.js"),
        ColorClosureTools = require("../colorclosure-tools.js");

    var ADD_POSITION_TO_ARGS = true;

    var ArgStorageType = ns.ArgStorageType = {
        FLOAT : 'float',
        FLOAT_BYTE: 'floatByte',
        FLOAT_UBYTE: 'floatUByte',
        FLOAT2: 'float2',
        FLOAT3: 'float3',
        FLOAT3_NORMAL: 'float3Normal',
        FLOAT4: 'float4'
    }

    var AMBIENT_DEFINITION = {type: Types.NUMBER, semantic: Shade.SEMANTICS.SCALAR_0_TO_1, defaultValue: 0 };


    ns.ColorClosureSignature = function(){
        this.id = 0;
        this.textureCount = 0;
        this.args = [];
        this.colorClosures = [];
    };
    Base.extend(ns.ColorClosureSignature.prototype, {
        construct: function(returnAast, scope){
            var closureInfo = collectClosureInfo(returnAast);
            var argAast = gatherClosureArgs(this, closureInfo, scope);
            var textures = allocateArgumentsToTextures(this);
            this.id = getSignatureId(this);
            argAast[0].value = this.id; // Set ID for shader id assignment
            return generateAast(textures, argAast);
        }
    });

    // Basic ColorClosureSignature Createion

    function addColorClosure(ccSig, colorClosureName, argIndices, envIndices){
        ccSig.colorClosures.push({
            name: colorClosureName,
            argIndices: argIndices,
            envIndices: envIndices
        });
    }

    function addArgument(ccSig, type, kind, storeType){
        var id = ccSig.args.length;
        ccSig.args.push({
            id: id,
            type: type,
            kind: kind,
            storeType: storeType,
            texIdx: undefined,
            componentIdx: undefined,
            bitIdx: undefined
        });
        return id;
    }

    // Argument Collection

    function collectClosureInfo(returnAast){
        var result = [];
        Traversal.traverse(returnAast, {
                leave: function(node, parent){
                    switch (node.type) {
                        case Syntax.CallExpression:
                            if(node.callee.type == Syntax.MemberExpression
                               && ANNO(node.callee.object).isOfKind(Kinds.COLOR_CLOSURE))
                            {
                                result.push({
                                    name: node.callee.property.name,
                                    args: node.arguments
                                });
                            }
                    }
                }
            });
        result.sort(function(a,b){return a.name < b.name ? -1 : a.name > b.name ? 1 : 0});
        return result;
    }

    function gatherClosureArgs(ccSig, closureInfo, scope){
        var argCache = {}, argAast = [];

        // Add argument for signature id;
        getCachedArgument(ccSig, {type: Types.INT}, {type: "Literal", value: "ID_UNSPECIFIED"}, argCache, argAast);
        if(ADD_POSITION_TO_ARGS)
            addPositionArgument(ccSig, argCache, argAast);
        var ambientValue = { type: Syntax.LogicalExpression, operator : "||",
                        left: getEnvAccess("ambientIntensity", AMBIENT_DEFINITION),
                        right: ColorClosureTools.getDefaultValue(AMBIENT_DEFINITION) };

        getCachedArgument(ccSig, AMBIENT_DEFINITION, ambientValue, argCache, argAast);

        for(var i = 0; i < closureInfo.length; ++i){
            var cInfo = closureInfo[i];
            var closureDefinition = Shade.ColorClosures[cInfo.name];
            if(!closureDefinition)
                throw new Error("Unknown Color closure '" + cInfo.name + "'");
            var argIndices = [], value;
            for(var j = 0; j < closureDefinition.input.length; ++j){
                var inputDefinition = closureDefinition.input[j];
                if(j < cInfo.args.length)
                    value = cInfo.args[j];
                else
                    value = ColorClosureTools.getDefaultValue(inputDefinition);
                var space = DeferredInfo[cInfo.name] && DeferredInfo[cInfo.name].inputSpaces[j];
                argIndices.push(getCachedArgument(ccSig, inputDefinition, value, argCache, argAast, space));
            }
            var envIndices = {};
            for(var property in closureDefinition.env){
                var envDefinition = closureDefinition.env[property];
                // TODO: Determine if env property is undefined and use defaultValue in this case;
                value = { type: Syntax.LogicalExpression, operator : "||",
                        left: getEnvAccess(property, envDefinition),
                        right: ColorClosureTools.getDefaultValue(envDefinition) };
                envIndices[property] = getCachedArgument(ccSig, envDefinition, value, argCache, argAast);
            }
            addColorClosure(ccSig, cInfo.name, argIndices, envIndices);
       }
       return argAast;
    }

    function addPositionArgument(ccSig, argCache, argAast){
        var positionLookup = { type: Syntax.MemberExpression,
            object: { type: Syntax.Identifier, name: "_env"},
            property: { type: Syntax.Identifier, name: "position"}
        }
        // ANNO(positionLookup).setType(Types.OBJECT, Kinds.FLOAT3);
        // ANNO(positionLookup.object).setType(Types.OBJECT, Kinds.ANY);
        // ANNO(positionLookup.object).setGlobal(true);
        getCachedArgument(ccSig, {type: Types.OBJECT, kind: Kinds.FLOAT3}, positionLookup, argCache, argAast,
            SpaceVectorType.VIEW_POINT);
    }

    function getCachedArgument(ccSig, inputDefinition, inputAast, argCache, argAast, space){
        space = space || SpaceVectorType.OBJECT;
        inputAast = space ? SpaceTransformTools.getSpaceTransformCall(inputAast, space) : inputAast;
        var keyAast = Base.deepExtend({}, inputAast);
        cleanAast(keyAast);
        var storageType = getStorageType(inputDefinition);
        var key = storageType + ";" + JSON.stringify(keyAast);
        if(argCache[key] === undefined){
            var argId = addArgument(ccSig, inputDefinition.type, inputDefinition.kind, storageType);
            argCache[key] = argId;
            argAast.push(inputAast);
        }
        return argCache[key];
    }
    /* Remove all range properties from the aast */
    function cleanAast(aast){
        for(var i in aast){
            if(i == "range" || i == "loc"){
                delete aast[i];
            }
            else if(typeof aast[i] == "object"){
                cleanAast(aast[i]);
            }
        }
    }

    function getStorageType(closureInputType){
        if(closureInputType.type == Types.NUMBER || closureInputType.type == Types.INT){
            return ArgStorageType.FLOAT;
        }
        else if(closureInputType.type == Types.OBJECT){
            switch(closureInputType.kind){
                case Kinds.FLOAT2: return ArgStorageType.FLOAT2;
                case Kinds.FLOAT3: return ArgStorageType.FLOAT3;
                case Kinds.FLOAT4: return ArgStorageType.FLOAT4;
                default:
                    throw new Error("Deferred input of this kind not supported: " + closureInputType.kind);
            };
        }
        else{
            throw new Error("Deferred input of this type not supported: " + closureInputType.type);
        }
    }

    function getEnvAccess(property, definition){
        var result = {
            type: Syntax.MemberExpression,
            object: {type: Syntax.Identifier, name: "_env" },
            property: {type: Syntax.Identifier, name: property }
        }
        // ANNO(result).setType(definition.type, definition.kind);
        // var objAnno = ANNO(result.object);
        // objAnno.setType(Types.OBJECT, Kinds.ANY);
        // objAnno.setGlobal(true);
        return result;
    }


    // Argument Allocation


    function allocateArgumentsToTextures(ccSig){
        var argCopy = ccSig.args.slice( ADD_POSITION_TO_ARGS ? 3 : 2);
        argCopy.sort(function(a, b){
            return getStorageSize(a.storeType) - getStorageSize(b.storeType);
        });
        argCopy.push(ccSig.args[ADD_POSITION_TO_ARGS ? 2 : 1]); // Ambient comes third.
        if(ADD_POSITION_TO_ARGS)
            argCopy.push(ccSig.args[1]); // POSITION comes second.
        argCopy.push(ccSig.args[0]); // ID argument always comes first (and thus: last in this array)
        var textures = [];
        var i = argCopy.length;
        while(i--){
            var arg = argCopy[i];
            assignTextureSlot(arg, textures);
        }
        ccSig.textureCount = textures.length;
        return textures;
    }
    function assignTextureSlot(arg, textures){
        var size = getStorageSize(arg.storeType);
        for(var i = 0; i < textures.length; i++){
            var tex = textures[i];
            if(size < 32){
                throw new Error("We currently don't support storing of values smaller than 32 bit");
            }
            else if(tex.usedComponents + size / 32 <= 4){
                arg.texIdx = i;
                arg.componentIdx = tex.usedComponents;
                arg.bitIdx = 0;
                tex.usedComponents += size / 32;
                tex.usedBits = 0;
                tex.storedArgs.push(arg);
                return;
            }
        }
        arg.texIdx = textures.length;
        arg.componentIdx = 0;
        arg.bitIdx = 0;
        if(size < 32){
            throw new Error("We currently don't support storing of values smaller than 32 bit");
        }
        else{
            textures.push({
                usedComponents: size / 32,
                usedBits: 0,
                storedArgs: [arg]
            });
        }
    }

    function getStorageSize(storeType){
        switch(storeType){
            case ArgStorageType.FLOAT: return 32;
            case ArgStorageType.FLOAT_BYTE: return 8;
            case ArgStorageType.FLOAT_UBYTE: return 8;
            case ArgStorageType.FLOAT2: return 64;
            case ArgStorageType.FLOAT3: return 96;
            case ArgStorageType.FLOAT3_NORMAL: return 24;
            case ArgStorageType.FLOAT4: return 128;
        }
    }

    // Get ColorClosureSignature ID

    var c_SignatureNextId = 0;
    var c_SignatureIDCache = {};

    ns.ColorClosureSignature.clearIdCache = function(){
        c_SignatureNextId = 0;
        c_SignatureIDCache = {};
    }

    function getSignatureId(ccSig){
        var key = "";
        for(var i = 0; i < ccSig.args.length; ++i){
            var arg = ccSig.args[i];
            key += getArgumentKey(arg) + ";"
        }
        for(i = 0; i < ccSig.colorClosures.length; ++i){
            var closure = ccSig.colorClosures[i];
            key += closure.name + "," + closure.argIndices.join(",");
            for(var prop in closure.envIndices){
                key += "," + prop + ">" + closure.envIndices[i];
            }
        }
        if(c_SignatureIDCache[key] === undefined){
            c_SignatureIDCache[key] = c_SignatureNextId;
            c_SignatureNextId++;
        }
        return c_SignatureIDCache[key];
    }

    function getArgumentKey(arg){
        return arg.type + "," + arg.kind + "," + arg.storeType + "," + arg.texIdx + ","
            + arg.componentIdx + "," + arg.bitIdx;
    }

    // Aast generation

    function generateAast(textures, argAast){
        var arrayExpression = { type: Syntax.ArrayExpression, elements: []};
        for(var i = 0; i < textures.length; ++i){
            var vectorExpression = generateVectorAast(textures[i], argAast);
            arrayExpression.elements.push(vectorExpression);
        }
        // ANNO(arrayExpression).setType(Types.ARRAY);

        var returnStatement = {type: Syntax.ReturnStatement, argument: arrayExpression};
        return returnStatement;
    }

    function generateVectorAast(texture, argAast){
        var vecArgs = [];
        for(var i = 0; i < texture.storedArgs.length; ++i){
            var arg = texture.storedArgs[i];
            var size = getStorageSize(arg.storeType);
            if(size < 32){
                throw new Error("We currently don't support storing of values smaller than 32 bit");
            }
            else{
                vecArgs.push(argAast[arg.id]);
            }
        }
        for(i = texture.usedComponents; i < 4; ++i){
            var zeroLiteral = { type: Syntax.Literal, value: "0" };
            // ANNO(zeroLiteral).setType(Types.INT);
            vecArgs.push(zeroLiteral);
        }
        var result = { type: Syntax.NewExpression, callee: { type: Syntax.Identifier, name: "Vec4"}, arguments: vecArgs};
        // ANNO(result).setType(Types.OBJECT, Kinds.FLOAT4);
        return result;
    }


}(exports));

},{"../../base/index.js":85,"../../generate/space/space-transform-tools.js":107,"../../interfaces.js":111,"../colorclosure-tools.js":113,"./../../base/annotation.js":80,"./xml3d-deferred.js":117,"estraverse":42}],116:[function(require,module,exports){
(function (ns) {

    var Closures = require("./xml3d-deferred.js"),
        Traversal = require('estraverse'),
        Syntax = Traversal.Syntax,
        parser = require('esprima'),
        Shade = require("../../interfaces.js"),
        ANNO = require("./../../base/annotation.js").ANNO,
        sanitizer = require("./../../analyze/sanitizer/sanitizer.js"),
        ColorClosureSignature = require("./color-closure-signature.js").ColorClosureSignature;


    ns.resolvePreTypeInference = function (aast, processData, opt) {
        var state = {
            colorClosureSignatures: [],
            inMain: false
        };
        var globalScrope = aast.scope;
        aast = Traversal.replace(aast, {
            enter: function(node, parent){
                switch(node.type){
                    case Syntax.FunctionDeclaration:
                        // TODO: Properly determine if we are in main function
                        if(node.id.name == "shade")
                            state.inMain = true;
                        else
                            this.skip();
                        break;
                }
            },
            leave: function(node, parent){
                switch(node.type){
                    case Syntax.FunctionDeclaration:
                        // TODO: Properly determine if we are in main function
                        if(node.id.name == "shade")
                            state.inMain = false;
                        break;
                    case Syntax.ReturnStatement:
                        if(state.inMain){
                            var signature = new ColorClosureSignature();
                            var replacement = signature.construct(node, globalScrope);
                            state.colorClosureSignatures.push(signature);
                            return replacement;
                        }
                }
            }
        })

        processData['colorClosureSignatures'] = state.colorClosureSignatures;

        return aast;
    }

}(exports));

},{"../../interfaces.js":111,"./../../analyze/sanitizer/sanitizer.js":56,"./../../base/annotation.js":80,"./color-closure-signature.js":115,"./xml3d-deferred.js":117,"esprima":41,"estraverse":42}],117:[function(require,module,exports){
(function (ns) {

        var Shade = require("../../interfaces.js"),
            SpaceVectorType = Shade.SpaceVectorType;

        ns.emissive = {
            inputSpaces: [
                SpaceVectorType.OBJECT
            ]
        }

        ns.diffuse = {
            inputSpaces: [
                SpaceVectorType.OBJECT,
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT
            ]
        }

        ns.phong = {
            inputSpaces: [
                SpaceVectorType.OBJECT,
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT
            ]
        }

        ns.cookTorrance = {
            inputSpaces: [
                SpaceVectorType.OBJECT,
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT,
                SpaceVectorType.OBJECT
            ]
        }

        ns.ward = {
            inputSpaces: [
                SpaceVectorType.OBJECT,
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT,
                SpaceVectorType.OBJECT
            ]
        }

        ns.scatter = {
            inputSpaces: [
                SpaceVectorType.OBJECT,
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT
            ]
        }

        ns.reflect = {
            inputSpaces: [
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT
            ]
        }

        ns.refract = {
            inputSpaces: [
                SpaceVectorType.VIEW_NORMAL,
                SpaceVectorType.OBJECT,
                SpaceVectorType.OBJECT
            ]
        }

}(exports));

},{"../../interfaces.js":111}],118:[function(require,module,exports){
(function (ns) {

    var ClosuresImpl = require("./xml3d-forward.js"),
        LightLoop = require("./light-loop.js").LightLoop,
        Traversal = require('estraverse'),
        Syntax = Traversal.Syntax,
        parser = require('esprima'),
        Shade = require("../../interfaces.js"),
        ANNO = require("./../../base/annotation.js").ANNO,
        sanitizer = require("./../../analyze/sanitizer/sanitizer.js");

    var SpaceTransformTools = require("../../generate/space/space-transform-tools.js"),
        ColorClosureTools = require("../colorclosure-tools.js");



    function containsClosure(arr, name) {
        return arr.some(function (func) {
            return func.id.name == name;
        });
    }

    function getInjectAddition(destName, functionName, inputPre, ccName, colorClosureIndex ){
        var args = [];
        for(var i = 0; i < inputPre.length; ++i){
            args.push({ type: Syntax.Identifier, name: inputPre[i]});
        }
        var inputsCnt = Shade.ColorClosures[ccName].input.length;
        for(var i = 0; i < inputsCnt; ++i){
            args.push({ type: Syntax.Identifier, name: getColorClosureInputArg(colorClosureIndex, i)});
        }
        return {
            type: Syntax.ExpressionStatement,
            expression: { type: Syntax.AssignmentExpression,
                operator: "=",
                left: { type: Syntax.Identifier, name: destName},
                right: { type: Syntax.CallExpression,
                    callee: { type: Syntax.MemberExpression,
                        object: {type: Syntax.Identifier, name: destName},
                        property: {type: Syntax.Identifier, name: "add"}
                    },
                    arguments: [{ type: Syntax.CallExpression,
                        callee: {type: Syntax.Identifier, name: functionName},
                        arguments: args
                    }]
              }}
        };
    }

    function getColorClosureInject(ccName, functionMember, state){
        if(!ClosuresImpl[ccName])
            console.error("No implementation available for ColorClosure '" + ccName + "'" );
        if(!ClosuresImpl[ccName][functionMember])
            return null;
        var functionName = ccName + "_" + functionMember;
        if (!containsClosure(state.newFunctions, functionName)){
            var closureImplementation = ClosuresImpl[ccName][functionMember];
            try {
                var closureAST = parser.parse(closureImplementation.toString(), { raw: true });
                closureAST = sanitizer.sanitize(closureAST);
                closureAST.body[0].id.name = functionName;
                state.newFunctions.push(closureAST.body[0]);
            } catch (e) {
                console.error("Error in analysis of closure '", ccName + ">" + functionMember, "'", e);
                return;
            }
        }
        return functionName;
    }


    function injectBrdfEntry(ccNames, state){
        var result = {
            type: Syntax.BlockStatement,
            body: []
        };
        for(var i = 0; i < ccNames.length; ++i){
            var fName, ccName = ccNames[i];
            if(fName = getColorClosureInject(ccName, "getDiffuse", state)){
                result.body.push(getInjectAddition("kd", fName, ["L", "V"], ccName, i));
            }
            if(fName = getColorClosureInject(ccName, "getSpecular", state)){
                result.body.push(getInjectAddition("ks", fName, ["L", "V"], ccName, i));
            }
        }
        return result;
    }

    function injectAmbientEntry(ccNames, state){
        var result = {
            type: Syntax.BlockStatement,
            body: []
        };
        for(var i = 0; i < ccNames.length; ++i){
            var fName, ccName = ccNames[i];
            if(fName = getColorClosureInject(ccName, "getAmbient", state)){
                result.body.push(getInjectAddition("ambientColor", fName, ["ambientIntensity"], ccName, i));
            }
        }
        return result;
    }

    function injectEmissiveEntry(ccNames, state) {
        var result = {
            type: Syntax.BlockStatement,
            body: []
        };
        for(var i = 0; i < ccNames.length; ++i){
            var fName, ccName = ccNames[i];
            if(fName = getColorClosureInject(ccName, "getEmissive", state)){
                result.body.push(getInjectAddition("emissiveColor", fName, [], ccName, i));
            }
        }
        return result;
    }

    function injectRefractReflectEntry(ccNames, state){
        var result = {
            type: Syntax.BlockStatement,
            body: []
        };
        for(var i = 0; i < ccNames.length; ++i){
            var fName, ccName = ccNames[i];
            if(fName = getColorClosureInject(ccName, "getRefract", state)){
                result.body.push(getInjectAddition("refractColor", fName, ["position"], ccName, i));
            }
            if(fName = getColorClosureInject(ccName, "getReflect", state)){
                result.body.push(getInjectAddition("reflectColor", fName, ["position"], ccName, i));
            }
        }
        return result;
    }

    function injectColorClosureCalls(lightLoopFunction, ccNames, state){
        var result = Traversal.replace(lightLoopFunction.body, {
            enter: function(node, parent){
                if(node.type == Syntax.ExpressionStatement && node.expression.type == Syntax.Literal){
                    switch(node.expression.value){
                        case "BRDF_ENTRY": return injectBrdfEntry(ccNames, state);
                        case "AMBIENT_ENTRY": return injectAmbientEntry(ccNames, state);
                        case "EMISSIVE_ENTRY": return injectEmissiveEntry(ccNames, state);
                        case "REFRACT_REFLECT_ENTRY": return injectRefractReflectEntry(ccNames, state);
                    };

                }
            }
        });
        return result;
    }

    function getColorClosureInputArg(ccIndex, inputIndex){
        return "_cc" + ccIndex + "Input" + inputIndex;
    }

    function createLightLoopFunction(lightLoopFunctionName, ccNames, state){
        try {
            var lightLoopAst = parser.parse(LightLoop.toString(), { raw: true });
        } catch (e) {
            console.error("Error in analysis of the lightLoop", e);
            return;
        }
        var functionAast = lightLoopAst.body[0];
        functionAast.id.name = lightLoopFunctionName;

        for(var i = 0; i < ccNames.length; ++i){
            var ccName = ccNames[i];
            var ccInput = Shade.ColorClosures[ccName].input;
            for(var j = 0; j < ccInput.length; ++j){
                functionAast.params.push({
                    type: Syntax.Identifier,
                    name: getColorClosureInputArg(i,j)
                });
            }
        }
        injectColorClosureCalls(functionAast, ccNames, state);

        lightLoopAst = sanitizer.sanitize(lightLoopAst);
        return lightLoopAst.body[0];
    }

    function getLightLoopFunction(colorClosureList, state){
        var ccNames = [];
        for(var i = 0; i < colorClosureList.length; ++i)
            ccNames.push(colorClosureList[i].name);
        var lightLoopFunctionName = "lightLoop_" + ccNames.join("_");
        if (!containsClosure(state.newFunctions, lightLoopFunctionName)){
            state.newFunctions.push(createLightLoopFunction(lightLoopFunctionName, ccNames, state));
        }
        return lightLoopFunctionName;
    }

    function handleCallExpression(node, state, colorClosureList) {
        var callee = ANNO(node.callee);
        // console.log("Call", node.callee.property, callee.getTypeString(), node.callee.object)
        if(callee.isOfKind(Shade.OBJECT_KINDS.COLOR_CLOSURE)) {
            colorClosureList.push({ name: node.callee.property.name, args: node.arguments });
        }
    }

    function handleMemberExpression(node, state, parent) {
        var object = ANNO(node.object);
        if (object.isOfKind(Shade.OBJECT_KINDS.COLOR_CLOSURE)) {
            var closureName = node.property.name;
            if (!ClosuresImpl.hasOwnProperty(closureName)) {
                console.error("No implementation for closure '", closureName, "'");
                return;
            };
        }
    }

    function getClosureList(returnAast, state){
        var colorClosureList = [];
        Traversal.traverse(returnAast, {
            leave: function(node, parent){
                 switch (node.type) {
                    case Syntax.CallExpression:
                        return handleCallExpression(node, state, colorClosureList);
                    case Syntax.MemberExpression:
                        return handleMemberExpression(node, state, parent);
                }
            }
        });
        colorClosureList.sort(function (a, b){ return a.name < b.name ? -1 : a.name > b.name ? 1 : 0 });
        return colorClosureList;
    }

    function generateLightLoopCall(lightLoopFunction, colorClosureList, state){
        var args = [];

        var posArg = state.positionArg;
        if(!state.noSpaceTransform)
            posArg = SpaceTransformTools.getSpaceTransformCall(posArg, Shade.SpaceVectorType.VIEW_POINT);
        args.push(posArg)
        args.push(state.ambientArg);
        for(var i = 0; i < colorClosureList.length; ++i){
            var ccEntry = colorClosureList[i];
            var ccInput = Shade.ColorClosures[ccEntry.name].input;
            for(var j = 0; j < ccInput.length; ++j){
                var arg = ccEntry.args[j];
                if(!arg)
                    arg = ColorClosureTools.getDefaultValue(ccInput[j]);
                if(ccInput[j].semantic == Shade.SEMANTICS.NORMAL && !state.noSpaceTransform)
                    arg = SpaceTransformTools.getSpaceTransformCall(arg, Shade.SpaceVectorType.VIEW_NORMAL);
                args.push(arg);
            }
        }
        return {
            type: Syntax.CallExpression,
            callee: {type: Syntax.Identifier, name: lightLoopFunction},
            arguments: args
        };
    }

    function handleReturnStatement(returnAast, state){
        var list = getClosureList(returnAast, state);
        if(list.length == 0)
            return;
        var lightLoopFunction = getLightLoopFunction(list, state);
        var lighLoopCall = generateLightLoopCall(lightLoopFunction, list, state);
        returnAast.argument = lighLoopCall;
    }


    function replaceReturnStatements(programAast, state){
        var result = Traversal.replace(programAast, {
            enter: function(node, parent){
                 switch (node.type) {
                    case Syntax.ReturnStatement:
                        this.skip();
                        return handleReturnStatement(node, state);
                }
            }
        });
        return result;
    }

    function getEnvParameter(property){
        return { type: Syntax.MemberExpression,
                object: { type: Syntax.Identifier, name: "_env" },
                property: { type: Syntax.Identifier, name: property}};
    }

    ns.resolvePreTypeInference = function (ast, processData, opt) {
        var state = {
            positionArg: opt && opt.lightLoopPositionArg || null,
            ambientArg: opt && opt.lightLoopAmbientArg || null,
            noSpaceTransform: opt && opt.lightLoopNoSpaceTransform || false,
            program: ast,
            newFunctions: []
        }
        if(!state.positionArg)
            state.positionArg = getEnvParameter("position");
        if(!state.ambientArg)
            state.ambientArg = { type: Syntax.LogicalExpression, operator: "||",
                                 left: getEnvParameter("ambientIntensity"),
                                 right: {type: Syntax.Literal, value: 0} };

        ast = replaceReturnStatements(ast, state);

        state.newFunctions.forEach(function(newFunction) {
            state.program.body.unshift(newFunction);
        })

        return ast;
    }

}(exports));

},{"../../generate/space/space-transform-tools.js":107,"../../interfaces.js":111,"../colorclosure-tools.js":113,"./../../analyze/sanitizer/sanitizer.js":56,"./../../base/annotation.js":80,"./light-loop.js":119,"./xml3d-forward.js":120,"esprima":41,"estraverse":42}],119:[function(require,module,exports){
/**
 * Created with JetBrains WebStorm.
 * User: lachsen
 * Date: 12/17/13
 * Time: 1:21 PM
 * To change this template use File | Settings | File Templates.
 */
(function (ns) {

ns.LightLoop = function LightLoop(position, ambientIntensity){
    var V = position.flip().normalize(), dist, atten;
    var kdComplete = new Vec3(0,0,0), ksComplete = new Vec3(0,0,0);
    if (this.MAX_POINTLIGHTS)
    for (var i = 0; i < this.MAX_POINTLIGHTS; i++) {
        if (!this.pointLightOn[i])
            continue;

        var L = this.viewMatrix.mulVec(this.pointLightPosition[i], 1.0).xyz();
        L = L.sub(position);
        dist = L.length();
        L = L.normalize();

        var kd = new Vec3(0,0,0), ks = new Vec3(0,0,0);
        "BRDF_ENTRY";

        atten = 1.0 / (this.pointLightAttenuation[i].x() + this.pointLightAttenuation[i].y() * dist + this.pointLightAttenuation[i].z() * dist * dist);
        kd = kd.mul(this.pointLightIntensity[i]).mul(atten);
        ks = ks.mul(this.pointLightIntensity[i]).mul(atten);
        kdComplete = kdComplete.add(kd);
        ksComplete = ksComplete.add(ks);
    }
    if (this.MAX_DIRECTIONALLIGHTS)
    for (i = 0; i < this.MAX_DIRECTIONALLIGHTS; i++) {
        if (!this.directionalLightOn[i])
            continue;

        L = this.viewMatrix.mulVec(this.directionalLightDirection[i], 0).xyz();
        L = L.flip().normalize();

        var kd = new Vec3(0,0,0), ks = new Vec3(0,0,0);
        "BRDF_ENTRY";

        kd = kd.mul(this.directionalLightIntensity[i]);
        ks = ks.mul(this.directionalLightIntensity[i]);
        kdComplete = kdComplete.add(kd);
        ksComplete = ksComplete.add(ks);
    }
    if (this.MAX_SPOTLIGHTS)
    for (i = 0; i < this.MAX_SPOTLIGHTS; i++) {
        if (this.spotLightOn[i]) {
            L = this.viewMatrix.mulVec(this.spotLightPosition[i], 1.0).xyz();
            L = L.sub(position);
            dist = L.length();
            L = L.normalize();

            var lDirection = this.viewMatrix.mulVec(this.spotLightDirection[i].flip(), 0).xyz().normalize();
            var angle = L.dot(lDirection);
            if(angle > this.spotLightCosFalloffAngle[i]) {
                var kd = new Vec3(0,0,0), ks = new Vec3(0,0,0);
                "BRDF_ENTRY";

                var c = 1.0;
                if (this.spotLightCastShadow[i]) {
                    var wpos = this.viewInverseMatrix.mulVec(position, 1.0).xyz();

                    var lsPos = this.spotLightMatrix[i].mulVec(new Vec4(wpos, 1));
                    var perspectiveDivPos = lsPos.xyz().div(lsPos.w()).mul(0.5).add(0.5);
                    var lsDepth = perspectiveDivPos.z() - this.spotLightShadowBias[i];

                    var lightuv = perspectiveDivPos.xy();
                    var bitShift = new Vec4( 1.0 / ( 256.0 * 256.0 * 256.0 ), 1.0 / ( 256.0 * 256.0 ), 1.0 / 256.0, 1.0 );

                    var texSize = new Vec2(Math.max(this.coords.x(), this.coords.y())).mul(2);
                    var texelSize = new Vec2(1.0, 1.0).div(texSize);
                    var f = Math.fract(lightuv.mul(texSize).add(0.5));
                    var centroidUV = Math.floor(lightuv.mul(texSize).add(0.5));
                    centroidUV = centroidUV.div(texSize);

                    var lb = this.spotLightShadowMap[i].sample2D(centroidUV.add(texelSize.mul(new Vec2(0.0, 0.0)))).dot(bitShift);
                    if (lb >= lsDepth)
                        lb = 1.0;
                    else
                        lb = 0.0;

                    var lt = this.spotLightShadowMap[i].sample2D(centroidUV.add(texelSize.mul(new Vec2(0.0, 1.0)))).dot(bitShift)
                    if (lt >= lsDepth)
                        lt = 1.0;
                    else
                        lt = 0.0;

                    var rb = this.spotLightShadowMap[i].sample2D(centroidUV.add(texelSize.mul(new Vec2(1.0, 0.0)))).dot(bitShift);
                    if (rb >= lsDepth)
                        rb = 1.0;
                    else
                        rb = 0.0;

                    var rt = this.spotLightShadowMap[i].sample2D(centroidUV.add(texelSize.mul(new Vec2(1.0, 1.0)))).dot(bitShift);
                    if (rt >= lsDepth)
                        rt = 1.0;
                    else
                        rt = 0.0;

                    var a = Math.mix(lb, lt, f.y());
                    var b = Math.mix(rb, rt, f.y());
                    c = Math.mix(a, b, f.x());
                }

                var softness = 1.0;
                if(angle < this.spotLightCosSoftFalloffAngle[i])
                    softness = (angle - this.spotLightCosFalloffAngle[i]) /
                        (this.spotLightCosSoftFalloffAngle[i] -  this.spotLightCosFalloffAngle[i]);

                atten = 1.0 / (this.spotLightAttenuation[i].x() + this.spotLightAttenuation[i].y() * dist + this.spotLightAttenuation[i].z() * dist * dist);
                kd = kd.mul(this.spotLightIntensity[i]).mul(atten * softness * c);
                ks = ks.mul(this.spotLightIntensity[i]).mul(atten * softness * c);
                kdComplete = kdComplete.add(kd);
                ksComplete = ksComplete.add(ks);
            }
        }
    }
    var ambientColor = new Vec3(0,0,0);
    "AMBIENT_ENTRY";
    kdComplete = kdComplete.add(ambientColor);
    var emissiveColor = new Vec3(0, 0, 0);
    "EMISSIVE_ENTRY"
    if (this.ssaoMap) {
        kdComplete = kdComplete.mul(1 - this.ssaoMap.sample2D(this.normalizedCoords).r());
    }
    var refractColor = new Vec3(0, 0, 0);
    var reflectColor = new Vec3(0, 0, 0);
    "REFRACT_REFLECT_ENTRY"
    return Math.pow(new Vec4(emissiveColor.add(kdComplete.add(ksComplete)).add(refractColor).add(reflectColor), 1.0), new Vec4(1/2.2));
}

}(exports));

},{}],120:[function(require,module,exports){
(function (ns) {

        ns.emissive = {
            getEmissive: function getEmissive(color){
                return color;
            }
        };

        ns.diffuse = {
            getDiffuse: function getDiffuse(L, V, color, N, roughness){
                // If a roughness is defined we use Oren Nayar brdf.
                var a, b, NdotV, thetaOut, phiOut, thetaIn;
                var cosPhiDiff, alpha, beta;
                var NdotL = Math.saturate(N.dot(L));

                // Lambertian reflection is constant over the hemisphere.
                var brdf = 1.0;

                if (roughness > 0) {
                    a = 1.0 - (roughness * roughness) / (2 * (roughness * roughness + 0.33));
                    b = 0.45 * (roughness * roughness) / (roughness * roughness + 0.09);
                    NdotV = N.dot(V);
                    thetaOut = Math.acos(NdotV);
                    phiOut = V.sub(N.mul(NdotV)).normalize();
                    thetaIn = Math.acos(NdotL);
                    cosPhiDiff = phiOut.dot(L.sub(N.mul(NdotL)).normalize());
                    alpha = Math.max(thetaOut, thetaIn);
                    beta = Math.min(thetaOut, thetaIn);
                    brdf = (a + b * Math.saturate(cosPhiDiff) * Math.sin(alpha) * Math.tan(beta));
                }
                brdf *= NdotL;
                return color.mul(brdf);
            },

            getAmbient: function getAmbient(ambientIntensity, color, N, roughness){
                return color.mul(ambientIntensity);
            }
        };

        ns.phong = {
            getSpecular: function getSpecular(L, V, color, N, shininess){
                var R = L.reflect(N).normalize();
                var eyeVector = V.flip();
                return color.mul(Math.pow(Math.max(R.dot(eyeVector),0.0), shininess*128.0));
            }
        };

        ns.cookTorrance = {
            getSpecular: function getSpecular(L, V, color, N, ior, roughness){
                var R0 = Math.pow((1 - ior) / (1 + ior), 2);
                var H = V.add(L).normalize(),
                    NdotH = N.dot(H),
                    NdotL = Math.saturate(N.dot(L)),
                    HdotN = H.dot(N),
                    HdotL = H.dot(L),
                    HdotV = H.dot(V),
                    NdotV = N.dot(V);

                // Beckmann distribution
                var alpha = Math.acos(NdotH),
                    numerator = Math.exp(-Math.pow(Math.tan(alpha) / roughness, 2)),
                    denominator = Math.pow(roughness, 2) * Math.pow(NdotH, 4),
                    d =  Math.max(0, numerator / denominator);

                // Geometric attenuation
                var G1 = 2 * HdotN * NdotV / HdotV,
                    G2 = 2 * HdotN * NdotL / HdotV,
                    g =  Math.min(1, Math.max(0, Math.min(G1, G2))),
                    f = Math.max(0, R0 + (1 - R0) * Math.pow(1 - NdotH, 5));

                var brdf = d * g * f / (Math.PI * NdotV);
                return color.mul(brdf);
            }
        };

        ns.ward = {
            getSpecular: function getSpecular(L, V, color, N, T, ax, ay){
                var H = L.add(V).normalize();
                var B = N.cross(T).normalize();
                var NdotV = N.dot(V);
                var NdotL = Math.saturate(N.dot(L));
                var NdotH = N.dot(H);
                var HdotT = H.dot(T);
                var HdotB = H.dot(B);

                var first = 1 / (4 * Math.PI * ax * ay * Math.sqrt(NdotL * NdotV));
                var beta = -(Math.pow(HdotT / ax, 2) + Math.pow(HdotB / ay, 2)) / (NdotH * NdotH);
                var second = Math.exp(beta);
                var brdf = Math.max(0, first * second) * NdotL;

                return color.mul(brdf);
            }
        };

        ns.scatter = {
            getSpecular: function getSpecular(L, V, color, N, wrap, scatterWidth){
                var NdotL = Math.saturate(N.dot(L));

                var NdotLWrap = (NdotL + wrap) / (1 + wrap);
                var scatter = Math.smoothstep(0.0, scatterWidth, NdotLWrap) * Math.smoothstep(scatterWidth * 2.0, scatterWidth, NdotLWrap);

                return color.mul(scatter);
            }
        };

        ns.reflect = {
            getReflect: function getReflect(position, N, factor) {
                N = this.viewInverseMatrix.mulVec(N, 0).xyz();
                var I = this.viewInverseMatrix.mulVec(position, 1.0).xyz().sub(this.cameraPosition).normalize();
                var reflection3D = I.reflect(N).normalize();
                var reflection2D = new Vec2((Math.atan2(-reflection3D.z(), reflection3D.x()) + Math.PI) / (2 * Math.PI), (Math.asin(reflection3D.y()) + Math.PI / 2.0) / Math.PI);
                return Math.pow(this.environment.sample2D(reflection2D).rgb(), new Vec3(2.2)).mul(factor);
            }
        };

        ns.refract = {
            getRefract: function getRefract(position, N, eta, factor) {
                N = this.viewInverseMatrix.mulVec(N, 0).xyz();
                var I = this.viewInverseMatrix.mulVec(position, 1.0).xyz().sub(this.cameraPosition).normalize();
                var refraction3D = I.refract(N, eta).normalize();
                var refraction2D = new Vec2((Math.atan2(-refraction3D.z(), refraction3D.x()) + Math.PI) / (2 * Math.PI), (Math.asin(refraction3D.y()) + Math.PI / 2.0) / Math.PI);
                return Math.pow(this.environment.sample2D(refraction2D).rgb(), new Vec3(2.2)).mul(factor);
            }
        };

}(exports));

},{}]},{},[110])(110)
});