var RenderAdapter = require("./base.js");

var TransformableAdapter = function (factory, node, handleShader, handleTransform) {
    RenderAdapter.call(this, factory, node);
    this.renderNode = null;
    this.handleShader = handleShader || false;
    if (handleTransform) {
        this.transformFetcher = new XML3D.data.DOMTransformFetcher(this, "transform", "transform");
    }

};
XML3D.createClass(TransformableAdapter, RenderAdapter);

XML3D.extend(TransformableAdapter.prototype, {
    onDispose: function () {
        this.transformFetcher && this.transformFetcher.clear();
    }, onConfigured: function () {
    }, getRenderNode: function () {
        if (!this.renderNode) {
            this.renderNode = this.createRenderNode ? this.createRenderNode() : null;
            this.updateLocalMatrix();
        }
        return this.renderNode;
    }, updateLocalMatrix: function () {
        this.transformFetcher && this.transformFetcher.update();
    }, onTransformChange: function (attrName, matrix) {
        if (attrName == "transform") {
            this.renderNode.setLocalMatrix(matrix);
        }

    }, getShaderHandle: function () {
        var shaderHref = this.node.shader;
        if (shaderHref == "") {
            var styleValue = this.node.getAttribute('style');
            if (styleValue) {
                var pattern = /shader\s*:\s*url\s*\(\s*(\S+)\s*\)/i;
                var result = pattern.exec(styleValue);
                if (result)
                    shaderHref = result[1];
            }
        }
        if (shaderHref) {
            return this.getAdapterHandle(shaderHref);
        }
    }, notifyChanged: function (evt) {
        if (evt.type == XML3D.events.VALUE_MODIFIED) {
            var target = evt.mutation.attributeName;
            if (target == "transform") {
                this.transformFetcher && this.transformFetcher.update();
            } else if (target == "style") {
                this.transformFetcher && this.transformFetcher.updateMatrix();
            } else if (target == "visible") {
                var newValue = evt.mutation.target.getAttribute("visible");
                this.renderNode.setLocalVisible(newValue && (newValue.toLowerCase() !== "false"));
                this.factory.renderer.requestRedraw("Transformable visibility changed.");
            } else if (target == "shader" && this.handleShader) {
                //this.disconnectAdapterHandle("shader");
                this.renderNode.setLocalShaderHandle(this.getShaderHandle());
                this.factory.renderer.requestRedraw("Transformable shader changed.");
            }
        }
    }
});

module.exports = TransformableAdapter;