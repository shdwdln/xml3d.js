var Frustum = require("../tools/frustum.js").Frustum;
var XC = require("../../../xflow/interface/constants.js");
var DataNode = require("../../../xflow/interface/graph.js").DataNode;
var InputNode = require("../../../xflow/interface/graph.js").InputNode;
var BufferEntry = require("../../../xflow/interface/data.js").BufferEntry;
var ComputeRequest = require("../../../xflow/interface/request.js").ComputeRequest;
var mat4 = require("gl-matrix").mat4;
var vec3 = require("gl-matrix").vec3;
var quat = require("gl-matrix").quat;

var PointLightData = {
    "intensity": {type: XC.DATA_TYPE.FLOAT3, 'default': [1, 1, 1]},
    "attenuation": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, 1]},
    "position": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, 0]},
    "shadowBias": {type: XC.DATA_TYPE.FLOAT, 'default': [0.0001]},
    "direction": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, -1]},
    "castShadow": {type: XC.DATA_TYPE.BOOL, 'default': [false]},
    "on": {type: XC.DATA_TYPE.BOOL, 'default': [true]},
    "matrix": {type: XC.DATA_TYPE.FLOAT4X4, 'default': [1, 0, 0, 0,   0, 1, 0, 0,    0, 0, 1, 0,  0, 0, 0, 1]},
    "nearFar": {type: XC.DATA_TYPE.FLOAT2, 'default': [1.0, 100.0]}
};

var SpotLightData = {
    "intensity": {type: XC.DATA_TYPE.FLOAT3, 'default': [1, 1, 1]},
    "attenuation": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, 1]},
    "position": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, 0]},
    "direction": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, -1]},
    "cutoffAngle": {type: XC.DATA_TYPE.FLOAT, 'default': [Math.PI / 4]},
    "softness": {type: XC.DATA_TYPE.FLOAT, 'default': [0.0]},
    "shadowBias": {type: XC.DATA_TYPE.FLOAT, 'default': [0.0001]},
    "castShadow": {type: XC.DATA_TYPE.BOOL, 'default': [false]},
    "matrix": {type: XC.DATA_TYPE.FLOAT4X4, 'default': [1, 0, 0, 0,   0, 1, 0, 0,    0, 0, 1, 0,  0, 0, 0, 1]},
    "on": {type: XC.DATA_TYPE.BOOL, 'default': [true]}
};

var DirectionalLightData = {
    "intensity": {type: XC.DATA_TYPE.FLOAT3, 'default': [1, 1, 1]},
    "direction": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, -1]},
    "shadowBias": {type: XC.DATA_TYPE.FLOAT, 'default': [0.0001]},
    "position": {type: XC.DATA_TYPE.FLOAT3, 'default': [0, 0, 0]},
    "castShadow": {type: XC.DATA_TYPE.BOOL, 'default': [false]},
    "on": {type: XC.DATA_TYPE.BOOL, 'default': [true]},
    "matrix": {type: XC.DATA_TYPE.FLOAT4X4, 'default': [1, 0, 0, 0,   0, 1, 0, 0,    0, 0, 1, 0,  0, 0, 0, 1]}
};


function createXflowData(config) {
    var data = new DataNode();
    for (var name in config) {
        var entry = config[name];
        createXflowValue(data, name, entry.type, entry['default']);
    }
    return data;
}

function createXflowValue(dataNode, name, type, value) {
    var buffer = new BufferEntry(type, new XC.TYPED_ARRAY_MAP[type](value));
    var inputNode = new InputNode();
    inputNode.data = buffer;
    inputNode.name = name;
    dataNode.appendChild(inputNode);
}

/**
 * Base class for light models
 * @param {string} id Unique id that identifies the light model
 * @param {RenderLight} light
 * @param {DataNode} dataNode
 * @param {Object} config Configuration that contains the light model's parameters and default values
 * @constructor
 */
var LightModel = function (id, light, dataNode, config) {
    this.id = id;
    this.light = light;
    this.configuration = config;
    this.parameters = Object.keys(config);
    /**
     * If the light has not data, just use the default parameters
     */
    if (dataNode) {
        var data = new DataNode();
        data.insertBefore(createXflowData(config), null);
        data.insertBefore(dataNode, null);
        this.dataNode = data;
    } else {
        this.dataNode = createXflowData(config);
    }

    // Horizontal opening angle of the light camera. Derived from cutoffAngle in case of spot light
    this.fovy =  Math.PI/2.0;

    this.lightParameterRequest = new ComputeRequest(this.dataNode, this.parameters, this.lightParametersChanged.bind(this));
    this.lightParametersChanged(this.lightParameterRequest, null);
};

LightModel.prototype = {
    /**
     * Copies the light parameters in an array of the same size
     * @param {Object} target Name to typed array map containing the data
     * @param {number} offset Slot in the array to be filled
     */
    fillLightParameters: function (target, offset) {
        var result = this.lightParameterRequest.getResult();
        this.parameters.forEach(function (name) {
            var entry = result.getOutputData(name);
            var size = XC.DATA_TYPE_TUPLE_SIZE[entry.type];
            var value = entry.getValue();
            target[name].set(value.subarray(0, size), offset * size);
        });
        this.transformParameters(target, offset);
    },

    allocateParameterArray: function (size) {
        var parameterArrays = {};
        var config = this.configuration;
        this.parameters.forEach(function (name) {
            var type = config[name].type;
            var tupleSize = XC.DATA_TYPE_TUPLE_SIZE[type];
            parameterArrays[name] = new XC.TYPED_ARRAY_MAP[type](tupleSize * size);
        });
        return parameterArrays;
    },

    getParameter: function(name) {
        if(name in this.configuration) {
            // No other checks required because parameters are always defined
            return this.lightParameterRequest.getResult().getOutputData(name).getValue();
        }
        return null;
    },

    lightParametersChanged: function (request, changeType) {
        if (changeType) {
            this.light.lightValueChanged();
        }
    },

    _expandNearFar:function(nfobject){
        var expand = Math.max((nfobject.far - nfobject.near) * 0.30, 0.05);
        nfobject.near -= expand;
        nfobject.far  += expand;
    },

    getLightData: function (target, offset) {
        var matrix = target["matrix"].subarray(offset * 16, offset * 16 + 16);
        this.getLightViewProjectionMatrix(matrix);
    },

    getLightViewProjectionMatrix: function (target) {
        var LVM = mat4.create();
        var LPM = mat4.create();
        this.getLightViewMatrix(LVM);
        this.getLightProjectionMatrix(LPM);
        XML3D.math.mat4.multiply(target, LPM, LVM);
    },

    getLightProjectionMatrix: function (target) {
        this.light.getFrustum(1).getProjectionMatrix(target);
    },

    getLightViewMatrix: (function() {
        var tmp = mat4.create();

        return function (mat) {
            var p_dir = this.getParameter("direction");
            var p_pos = this.getParameter("position");

            // Get the world matrix from the light in the transformation hierarchy
            // world => light
            this.light.getWorldMatrix(mat);

            // Derive rotation from the direction and standard direction (-z => no rotation)
            var q_rot = XML3D.math.quat.rotationTo(quat.create(),c_standardDirection, p_dir);
            // Create matrix from rotation and translation
            mat4.fromRotationTranslation(tmp, q_rot, p_pos);
            // Add to world matrix\
            mat4.mul(mat, mat, tmp);

            // Invert:  light => world
            mat4.invert(mat, mat);
        }
    })()

};

var c_tmpWorldMatrix = mat4.create();
var c_standardDirection = vec3.fromValues(0,0,-1);


function transformPose(light, position, direction) {
    light.getWorldMatrix(c_tmpWorldMatrix);
    if (position) {
        vec3.transformMat4(position, position, c_tmpWorldMatrix);
    }
    if (direction) {
        XML3D.math.vec3.transformDirection(direction, direction, c_tmpWorldMatrix);
        vec3.normalize(direction, direction);
    }
}

function transformDefault(target, offset, light) {
    target["on"][offset] = light.visible;
}


/**
 * Implement XML3D's predefined point light model urn:xml3d:light:point
 * @param {DataNode} dataNode
 * @param {RenderLight} light
 * @extends LightModel
 * @constructor
 */
var PointLightModel = function (dataNode, light) {
    LightModel.call(this, "point", light, dataNode, PointLightData);
};

XML3D.createClass(PointLightModel, LightModel, {
    getFrustum: function (aspect, sceneBoundingBox) {
        var orthogonal = false;
        var entry = this.light.scene.lights.getModelEntry(this.id);

        if (sceneBoundingBox.isEmpty()) {
            entry.parameters["nearFar"][0] = 1.0;
            entry.parameters["nearFar"][1] = 110.0;
            return new Frustum(1.0, 110.0, 0, this.fovy, aspect, orthogonal)
        }


        var t_mat = mat4.create();
        this.getLightViewMatrix(t_mat);
        sceneBoundingBox.transformAxisAligned(t_mat);

        var nf = {
            near: -sceneBoundingBox.max.z, far: -sceneBoundingBox.min.z
        };
        // Expand the view frustum a bit to ensure 2D objects parallel to the camera are rendered
        this._expandNearFar(nf);

        if (nf.far < 1.0) {
            nf.far = 110;
        }

        entry.parameters["nearFar"][0] = 1.0;
        entry.parameters["nearFar"][1] = nf.far;

        return new Frustum(1.0, nf.far, 0, this.fovy, aspect, orthogonal);
    },

    transformParameters: function (target, offset) {
        var position = target["position"].subarray(offset * 3, offset * 3 + 3);
        transformPose(this.light, position, null);
        transformDefault(target, offset, this.light);
    }
});




/**
 * Implement XML3D's predefined spot light model urn:xml3d:light:spot
 * @param {DataNode} dataNode
 * @param {RenderLight} light
 * @extends LightModel
 * @constructor
 */
var SpotLightModel = function (dataNode, light) {
    LightModel.call(this, "spot", light, dataNode, SpotLightData);
};


XML3D.createClass(SpotLightModel, LightModel, {
    getFrustum: function (aspect, sceneBoundingBox) {

        if (sceneBoundingBox.isEmpty()) {
            return new Frustum(1.0, 110.0, 0, this.fovy, aspect, false)
        }

        var t_mat = mat4.create();
        this.getLightViewMatrix(t_mat);
        sceneBoundingBox.transformAxisAligned(t_mat);

        var nf = {
            near: -sceneBoundingBox.max.z, far: -sceneBoundingBox.min.z
        };
        // Expand the view frustum a bit to ensure 2D objects parallel to the camera are rendered
        this._expandNearFar(nf);

        if (nf.far < 1.0) {
            nf.far = 110;
        }

        return new Frustum(1.0, nf.far, 0, this.fovy, aspect, false);
    },

    transformParameters: function (target, offset) {
        var position = target["position"].subarray(offset * 3, offset * 3 + 3);
        var direction = target["direction"].subarray(offset * 3, offset * 3 + 3);
        // Transform position and direction from object to world space
        transformPose(this.light, position, direction);
        transformDefault(target, offset, this.light);
    },

    lightParametersChanged: function (request, changeType) {
        this.fovy = this.getParameter("cutoffAngle")[0] * 2;
        LightModel.prototype.lightParametersChanged.call(this, request, changeType);
    }
});




/**
 * Implement XML3D's predefined spot light model urn:xml3d:light:directional
 * @param {DataNode} dataNode
 * @param {RenderLight} light
 * @extends LightModel
 * @constructor
 */
var DirectionalLightModel = function (dataNode, light) {
    LightModel.call(this, "directional", light, dataNode, DirectionalLightData);
};

XML3D.createClass(DirectionalLightModel, LightModel, {
    getFrustum: function(aspect, sceneBoundingBox) {
        var orthogonal = true;

        if (sceneBoundingBox.isEmpty()) {
            return new Frustum(1.0, 110.0, 0, this.fovy, aspect, orthogonal)
        }

        var t_mat = mat4.create();
        this.getLightViewMatrix(t_mat);
        sceneBoundingBox.transformAxisAligned(t_mat);

        var nf = {  near: -sceneBoundingBox.max.z,
                    far:  -sceneBoundingBox.min.z};
        // Expand the view frustum a bit to ensure 2D objects parallel to the camera are rendered
        this._expandNearFar(nf);

        if (nf.far < 1.0) {
            nf.far = 110;
        }

        return new Frustum(1.0, nf.far, 0, this.fovy, aspect, orthogonal);
    },

    transformParameters: function (target, offset) {
        var direction = target["direction"].subarray(offset * 3, offset * 3 + 3);
        transformPose(this.light, null, direction);
        transformDefault(target, offset, this.light);
    },



    getLightViewMatrix: function (mat) {
        var manager = this.light.scene.lights;
        var entry = manager.getModelEntry(this.id);
        var p_dir = entry.parameters["direction"];
        var p_pos = entry.parameters["position"];

        var bb = new XML3D.Box();
        this.light.scene.getBoundingBox(bb);
        var off = vec3.create();
        var bbCenter = bb.center();
        var bbSize = bb.size();
        var d = bbSize.length(); //diameter of bounding sphere of the scene
        vec3.scale(off, p_dir, -0.55 * d); //enlarge a bit on the radius of the scene
        p_pos = vec3.add(p_pos, bbCenter.data, off);
        entry.parameters["position"] = p_pos;


        //create new transformation matrix depending on the updated parameters
        mat4.identity(mat);
        var lookat_mat = mat4.create();
        var top_vec = vec3.fromValues(0.0, 1.0, 0.0);
        if ((p_dir[0] == 0.0) && (p_dir[2] == 0.0)) //check if top_vec colinear with direction
            top_vec = vec3.fromValues(0.0, 0.0, 1.0);
        var up_vec = vec3.create();
        var dir_len = vec3.len(p_dir);
        vec3.scale(up_vec, p_dir, -vec3.dot(top_vec, p_dir) / (dir_len * dir_len));
        vec3.add(up_vec, up_vec, top_vec);
        vec3.normalize(up_vec, up_vec);
        mat4.lookAt(lookat_mat, vec3.fromValues(0.0, 0.0, 0.0), p_dir, up_vec);
        mat4.invert(lookat_mat, lookat_mat);
        mat4.translate(mat, mat, p_pos);
        mat4.multiply(mat, mat, lookat_mat);

        bb = new XML3D.Box();
        this.light.scene.getBoundingBox(bb);
        bb.transformAxisAligned(mat);
        bbSize = bb.size().data;
        var max = (bbSize[0] > bbSize[1]) ? bbSize[0] : bbSize[1];
        max = 0.55 * (max);//enlarge 10percent to make sure nothing gets cut off
        this.fovy = max <= 0 ? Math.PI : Math.atan(max)*2.0;

        entry.parameters["direction"] = p_dir;
        entry.parameters["position"]  = p_pos;

        mat4.invert(mat, mat);
    }

});

module.exports = {
    PointLightModel: PointLightModel, SpotLightModel: SpotLightModel, DirectionalLightModel: DirectionalLightModel

};
