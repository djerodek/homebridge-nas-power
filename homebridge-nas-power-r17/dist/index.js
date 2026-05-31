"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const platform_1 = require("./platform");
exports.default = (api) => {
    api.registerPlatform(platform_1.PLUGIN_NAME, platform_1.PLATFORM_NAME, platform_1.NasPowerPlatform);
};
//# sourceMappingURL=index.js.map