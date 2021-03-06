var Base = require("../base.js");
var C = require("../interface/constants.js");
var OperatorList = require("../operator/operator-list.js");
var Utils = require("../utils/utils.js");
var Operator = require("../operator/operator.js");
var OperatorEntry = require("../operator/operator-entry.js");
var Program = require("../operator/program.js");

//----------------------------------------------------------------------------------------------------------------------
// Executor
//----------------------------------------------------------------------------------------------------------------------

/**
 * Tries to combine multiple ProcessNodes into a Program. Currently only used for vertex shaders.
 *
 * @param {RequestNode|ProcessNode} ownerNode
 * @param {C.PLATFORM} platform
 * @constructor
 */
var Executor = function(ownerNode, platform){
    this.platform = platform;

    /**
     * Nodes that are merged by this executor
     * @type {Array.<ProcessNode|RequestNode>}
     */
    this.mergedNodes = [];

    /**
     * Subset of this.mergedNodes that directly provide results of the executor
     * @type {Array.<ProcessNode>}
     */
    this.mergedOutputNodes = [];

    /**
     * ProcessNodes to be executed before this executor can be
     * executed
     * @type {Array.<ProcessNode>}
     */
    this.subNodes = [];

    /**
     * TODO: Unused. Remove?
     * @type {Array}
     */
    this.unprocessedDataNames = [];

    /**
     *  TODO: Maybe we should just store the cl-platform objects in global object so they are more easily available and
     *  to avoid long prototype chains. Or we could pass the graph context to each node of the graph.
     *  However, it would be good to allow each Graph object to have at least own context, cmdQueue and kernelManager.
     *  e.g. passing graph information here requires a long prototype chain
     */
    this.operatorList =  new OperatorList(platform);
    this.programData =  new Program.ProgramData();

    /**
     *
     * @type {Program}
     */
    this.program = null;

    constructExecutor(this, ownerNode);
};

    Executor.prototype.isProcessed = function(){
        var i = this.mergedOutputNodes.length;
        while(i--){
            if(this.mergedOutputNodes[i].status != C.PROCESS_STATE.PROCESSED)
                return false;
        }
        return true;
    };


    Executor.prototype.run = function(asyncCallback){
        runSubNodes(this);
        updateIterateState(this); // TODO check if iterate State has changes in any way and only refetch program in that case

        this.program = Program.createProgram(this.operatorList);

        if(this.program){
            this.operatorList.allocateOutput(this.programData, !!asyncCallback);
            this.program.run(this.programData, asyncCallback);
        }
        if(this.platform != C.PLATFORM.ASYNC){
            var i = this.mergedOutputNodes.length;
            while(i--){
                this.mergedOutputNodes[i].status = C.PROCESS_STATE.PROCESSED;
            }
        }


    };

    Executor.prototype.getVertexShader = function(){
        runSubNodes(this);
        updateIterateState(this);

        this.program = Program.createProgram(this.operatorList);

        return this.program;
    };

/**
 * Construct Executor
 * @param executer
 * @param ownerNode
 */
function constructExecutor(executer, ownerNode){
    var cData = {
        blockedNodes: [],   // Bad Nodes that cannot be merge. Filled during pre scan
        doneNodes: [],      // Nodes that have been signed up for merging. TODO: Redundant with constructionOrder and subNodes? - maybe yes!
        constructionOrder: [], // Store nodes in order of construction of OperatorEntries.
        inputSlots: {},     // Collected input channels of all merged nodes. Used to avoid assigning same input buffer twice
        finalOutput: null,  // finalOutput channes in case we have a RequestNode
        firstOperator: null // Set to first operator that has been merged (will be executed last)
    };
    var requestNode = initRequestNode(cData, executer, ownerNode);

    var noOperators = false; // TODO: Remove this?
    constructPreScan(cData, ownerNode, executer.platform, noOperators);

    setConstructionOrderAndSubNodes(cData, executer, ownerNode);

    constructFromData(executer, cData);
}
/**
 * Only relevant if ownerNodes is a RequestNode
 * Sets finalOutput of construction data and unprocessedDataNames
 * @param cData
 * @param executer
 * @param ownerNode
 * @returns {boolean}
 */
function initRequestNode(cData, executer, ownerNode){
    if(true) { // FIXME: ownerNode instanceof RequestNode){
        cData.finalOutput = {};
        var filter = ownerNode.filter || ownerNode.owner.outputChannels.getNames();
        for(var i = 0; i < filter.length; ++i){
            var name = filter[i];
            var channel = ownerNode.owner.outputChannels.getChannel(name);
            if(channel && channel.creatorProcessNode)
                cData.finalOutput[name] = channel.getDataEntry();
        }
        Utils.nameset.add(executer.unprocessedDataNames, filter);
        return true;
    }
    return false;
}
/**
 * Goes to processing subtree at filled blockedNodes array in construction data.
 * All nodes that cannot be merged or have parents that can't be merged will be blocked
 * @param cData
 * @param node
 * @param platform
 * @param noOperators
 */
function constructPreScan(cData, node, platform, noOperators){
    if(cData.blockedNodes.indexOf(node) != -1)
        return;

    if(node.operator){
        if(noOperators || !canOperatorMerge(cData, node.operator, platform)){
            blockSubtree(cData, node);
            return;
        }
        else{
            if(!cData.firstOperator) cData.firstOperator = node.operator;
            var mapping = node.operator.mapping;
            for(var i = 0; i < mapping.length; ++i){
                if(mapping[i].sequence){
                    blockInput(cData, node, mapping[i].source);
                    blockInput(cData, node, mapping[i].keySource);
                }
                else if(mapping[i].array){
                    // TODO: Rename .array to .randomAccess
                    blockInput(cData, node, mapping[i].source);
                }
            }
        }
    }
    for(var i = 0; i < node.children.length; ++i){
        constructPreScan(cData, node.children[i], platform, noOperators);
    }
}

function canOperatorMerge(cData, operator, platform){
    // TODO: Detect merge support
    return (platform == C.PLATFORM.ASYNC || !Operator.isOperatorAsync(operator)) &&
        (!cData.firstOperator ||
        (platform == C.PLATFORM.GLSL && cData.firstOperator.evaluate_glsl && operator.evaluate_glsl));
}

function blockSubtree(cData, node){
    if(cData.blockedNodes.indexOf(node) != -1)
        return;

    cData.blockedNodes.push(node);
    for(var i = 0; i < node.children.length; ++i){
        blockSubtree(cData, node.children[i]);
    }
}
/**
 * Block all processNodes assigned to an input channel
 * @param cData
 * @param node
 * @param inputName
 */
    function blockInput(cData, node, inputName){
        var channel = node.inputChannels[inputName];
        if(channel && channel.creatorProcessNode){
            blockSubtree(cData, channel.creatorProcessNode);
        }
    }
/**
 * Fill doneNodes and constructionOrder arrays of construction data.
 * It also fills the subNodes array of the executer
 * @param cData construction data
 * @param executer
 * @param node
 */
    function setConstructionOrderAndSubNodes(cData, executer, node){
        if(cData.doneNodes.indexOf(node) != -1)
            return;

        cData.doneNodes.push(node);

        if(cData.blockedNodes.indexOf(node) != -1){
            executer.subNodes.push(node);
        }
        else{
            for(var i = 0; i < node.children.length; ++i){
                setConstructionOrderAndSubNodes(cData, executer, node.children[i]);
            }

            if(node.operator){ // RequestNodes don't have an operator. Consider this case.
                cData.constructionOrder.push(node);
            }
        }
    }
/**
 * Last step of construction: create OperatorList from constructionOrder array
 * Also fill mergedNodes and programData
 * @param executer
 * @param cData
 */
    function constructFromData(executer, cData){

        for(var i = 0; i < cData.constructionOrder.length; ++i){
            var node = cData.constructionOrder[i];

            var entry = new OperatorEntry(node.operator);

            constructInputConnection(executer, entry, cData, node);

            var isOutputNode = constructOutputConnection(executer, entry, cData, node);

            executer.programData.operatorData.push({});
            executer.operatorList.addEntry(entry);
            executer.mergedNodes.push(node);
            if(isOutputNode || (i == cData.constructionOrder.length-1))
                executer.mergedOutputNodes.push(node)

        }

        constructLostOutput(executer, cData);
    }
/**
 * Construct input info for OperatorEntry.
 * Will implicitly create ProgramInputConnections for ProgramData
 * @param {Executor} executer
 * @param {OperatorEntry} entry
 * @param {{}} cData
 * @param {ProcessNode} node
 */
    function constructInputConnection(executer, entry, cData, node){
        var mapping = node.operator.mapping;
        for(var j = 0; j < mapping.length; ++j){
            var channel = node.inputChannels[mapping[j].source];
            var operatorIndex;
            if(channel && channel.creatorProcessNode && (operatorIndex =
                executer.mergedNodes.indexOf(channel.creatorProcessNode) ) != -1 )
            {
                // it's transfer input
                var outputIndex = getOperatorOutputIndex(channel.creatorProcessNode, channel);
                entry.setTransferInput(j, operatorIndex, outputIndex);
                var prevOperator = executer.operatorList.entries[operatorIndex];
                if(!prevOperator.isFinalOutput(outputIndex)){
                    prevOperator.setTransferOutput(outputIndex);
                }
                continue;
            }
            // Handle direct input

            var mappedInputName = mapping[j].source;
            if(node.owner.owner._computeInputMapping)
                mappedInputName = node.owner.owner._computeInputMapping.getScriptInputName(mapping[j].paramIdx, mapping[j].source);

            var connection = new Program.ProgramInputConnection();
            connection.channel = channel;
            connection.arrayAccess = mapping[j].array || false; // TODO: rename to randomAccess
            connection.sequenceAccessType = mapping[j].sequence || 0;
            if(connection.sequenceAccessType)
                connection.sequenceKeySourceChannel = node.inputChannels[mapping[j].keySource];

            var connectionKey = connection.getKey();
            var inputSlotIdx = cData.inputSlots[connectionKey];
            if(channel && inputSlotIdx != undefined){
                // Direct input already exists
                entry.setDirectInput(j, inputSlotIdx, mappedInputName);
            }
            else{
                // new direct input
                inputSlotIdx = executer.programData.inputs.length;
                cData.inputSlots[connectionKey] = inputSlotIdx;
                executer.programData.inputs.push(connection);
                entry.setDirectInput(j, inputSlotIdx, mappedInputName);
            }
        }
    }

/**
 * Construct output info of OperatorEntry
 * @param {Executor} executer
 * @param {OperatorEntry} entry
 * @param {{}} cData
 * @param {ProcessNode} node
 */
    function constructOutputConnection(executer, entry, cData, node){
        var outputs = node.operator.outputs;
        var isOutputNode = true;
        for(var i = 0; i < outputs.length; ++i){
            var slot = node.outputDataSlots[outputs[i].name];
            var finalOutputName = getFinalOutputName(slot, cData);
            if(finalOutputName){
                var index =  executer.programData.outputs.length;
                executer.programData.outputs.push(slot);
                entry.setFinalOutput(i, index);
                if(finalOutputName !== true){
                    Utils.nameset.remove(executer.unprocessedDataNames, finalOutputName);
                }
            }
            else{
                isOutputNode = false;
            }
        }
        return isOutputNode; // TODO: Check if computation of isOutputNode is really correct?
    }


    function getOperatorOutputIndex(processNode, channel){
        var outputs = processNode.operator.outputs;
        for(var i = 0; i < outputs.length; ++i){
            if(channel.getDataEntry() == processNode.outputDataSlots[outputs[i].name].dataEntry){
                return i;
            }
        }
        return null;
    }

    function getFinalOutputName(dataSlot, cData){
        if(!cData.finalOutput) // If root of Executor is a ProcessNode we don't have finalOutput defined and all outputs are final.
            return true;
        for(var name in cData.finalOutput){
            if(cData.finalOutput[name] == dataSlot.dataEntry){
                return name;
            }
        }
        return false;
    }

    function constructLostOutput(executer, cData){
        for(var i = 0; i < cData.constructionOrder.length; ++i){
            var node = cData.constructionOrder[i];
            var entry = executer.operatorList.entries[i];

            var outputs = node.operator.outputs;
            for(var j = 0; j < outputs.length; ++j){
                if(!entry.isFinalOutput(j) && ! entry.isTransferOutput(j)){
                    var index = executer.programData.outputs.length;
                    executer.programData.outputs.push(node.outputDataSlots[outputs[j].name]);
                    entry.setLostOutput(j, index);
                }
            }
        }
    }


    function updateIterateState(executer){
        var inputs = executer.programData.inputs;
        for(var i = 0; i < executer.programData.inputs.length; ++i){
            var entry = executer.programData.getDataEntry(i);
            var iterateCount = entry ? entry.getIterateCount ? entry.getIterateCount() : 1 : 0;
            if(!iterateCount)
                executer.operatorList.setInputIterateType(i, C.ITERATION_TYPE.NULL);
            else if(!inputs[i].arrayAccess && iterateCount > 1)
                executer.operatorList.setInputIterateType(i, C.ITERATION_TYPE.MANY);
            else
                executer.operatorList.setInputIterateType(i, C.ITERATION_TYPE.ONE);

            if(inputs[i].arrayAccess && platformRequiresArraySize(executer. platform)){
                executer.operatorList.setInputSize(i, iterateCount);
            }
        }
    }
/**
 * Determine if the platform needs to declare uniform array sizes in the source code.
 * @param platform
 * @returns {boolean}
 */
    function platformRequiresArraySize(platform){
        return platform == C.PLATFORM.GLSL;
    }


    function runSubNodes(executer){
        for(var i = 0; i < executer.subNodes.length; ++i){
            executer.subNodes[i].process();
        }
    }

module.exports = Executor;
