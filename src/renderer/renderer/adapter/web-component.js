var GroupRenderAdapter = require("./group.js");
var Events = require("../../../interface/notification.js");

var WebComponentRenderAdapter = function (factory, node) {
    GroupRenderAdapter.call(this, factory, node);
};

XML3D.createClass(WebComponentRenderAdapter, GroupRenderAdapter, {

    notifyChanged: function (evt) {
        switch (evt.type) {
            case Events.ADAPTER_HANDLE_CHANGED:
                GroupRenderAdapter.prototype.notifyChanged.call(this, evt);
                break;
            case Events.THIS_REMOVED:
                this.dispose();
                this.factory.renderer.requestRedraw("Web component removed");
                break;
            case Events.NODE_INSERTED:
                if (evt.affectedNode.getDestinationInsertionPoints) {
                    var endpoints = evt.affectedNode.getDestinationInsertionPoints();
                    for (var i=0; i<endpoints.length; i++) {
                        var adapters = endpoints[i]._configured ? endpoints[i]._configured.adapters : {};
                        for (var name in adapters) {
                            adapters[name].notifyChanged(evt);
                        }
                    }
                } else {
                    this.initElement(evt.affectedNode);
                }
                break;
            default:
                XML3D.debug.logDebug("Unhandled event in WebComponentRenderAdapter:", evt);
        }
    }

});

module.exports = WebComponentRenderAdapter;
