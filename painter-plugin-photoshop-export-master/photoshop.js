function exportMaps() {
  var paths = alg.settings.value("exportMaps", {})

  return {
    isChecked: function isChecked(path) {
      return !(path in paths) || !!paths[path];
    }
  }
}

function ExportConfig() {
  this.padding = "Infinite"
  this.dilation = 0
  this.bitDepth = 8
  this.keepAlpha = true
}

ExportConfig.prototype = {
  clone: function() {
    var conf = new ExportConfig
    conf.padding = this.padding
    conf.dilation = this.dilation
    conf.bitDepth = this.bitDepth
    conf.keepAlpha = this.keepAlpha
    return conf
  },

  usePadding : function(val) {
    this.padding = (val === true) ? "Infinite" : "Transparent"
  }
}

function PhotoshopExporter(callback) {
  this.logUserInfo =
    function logUserInfo(str) {
      if (callback) {
        callback(str)
      }
      else {
        alg.log.info("<font color=#00FF00>"+str+"</font>")
      }
    }

  this.exportConfig = new ExportConfig()
  this.exportConfig.usePadding(alg.settings.value("padding", true))

  var projectName = alg.project.name()
  this.exportPath = alg.mapexport.exportPath() + "/" + projectName + "_photoshop_export/";

  var headerScript = alg.fileIO.open(alg.plugin_root_directory + "/header.jsx", 'r');
  this.photoshopScript = headerScript.readAll();
  headerScript.close();

  this.run(this);

  var footerScript = alg.fileIO.open(alg.plugin_root_directory + "/footer.jsx", 'r');
  this.photoshopScript += footerScript.readAll();
  footerScript.close();

  try{
    var scriptFile = alg.fileIO.open(this.exportPath + "/photoshopScript.jsx", 'w');
    scriptFile.write(this.photoshopScript);
    scriptFile.close();
  } catch (error) {
    alg.log.error(error.message);
    return;
  }

  // 核心修复：强制延迟 1.5 秒，让系统硬盘有时间把脚本存好，彻底消灭“代码丢失”报错！
  var delayStart = new Date().getTime();
  while (new Date().getTime() < delayStart + 1500) { /* Wait for OS I/O flush */ }

  this.logUserInfo("Export done");
  if (alg.settings.value("launchPhotoshop", false)) {
    this.logUserInfo("Starting Photoshop...");
    if (Qt.platform.os == "windows") {
      alg.subprocess.startDetached(["\"" + alg.settings.value("photoshopPath", "") + "\"", "\"" + this.exportPath.split('/').join('\\') + "photoshopScript.jsx\""]);
    } else if (Qt.platform.os == "osx") {
      alg.subprocess.startDetached(["open", "-a", alg.settings.value("photoshopPath", "").split(' ').join('\ '), this.exportPath.split(' ').join('\ ') + "photoshopScript.jsx"]);
    }
  }
}

PhotoshopExporter.prototype = {

  run: function() {
    var mapsList = Photoshop.exportMaps();

    function documentNbStacks(document) {
      return document.materials
        .map(function(m) {
          return !mapsList.isChecked(m.name)?
            0 :
            m.stacks.filter(function(s) {
              return mapsList.isChecked(m.name + "." + s.name);
            }).length; 
        })
        .reduce(function(a, b){ return a + b}, 0); 
    }
    function stackNbChannel(materialName, stack) {
      return stack.channels
        .filter(function(c) {
          return mapsList.isChecked(materialName + "." + stack.name + "." + c);
        }).length;
    }
    function elementNbLayers(element) {
      var nbLayers = 1;
      if (element.layers != undefined) {
        nbLayers = element.layers
          .map(elementNbLayers)
          .reduce(function(a, b){ return a + b}, 0);
      }
      return nbLayers + (element.hasMask? 1 : 0);
    }
    var self = this;
    function createProgressMethod(progressBar, total) {
      var progression = 1;
      return function() {
        if (progressBar === "layer") {
          var stackPath = [self.materialName, self.stackName, self.channel].filter(function(e) {return e}).join("/");
          self.logUserInfo("Exporting " + stackPath + " layers and masks: " + progression + "/" + total);
        }
        self.photoshopScript +=
          "progressBar." + progressBar + ".value = " + 100/total*(progression++) + ";\n";
      }
    }

    var doc_str = alg.mapexport.documentStructure();
    var stackProgress = createProgressMethod("stack", documentNbStacks(doc_str));

    for (var materialId in doc_str.materials) {
      var material = doc_str.materials[materialId];
      if (!mapsList.isChecked(material.name)) continue
      this.materialName = material.name;
      for (var stackId in material.stacks) {
        var stack = material.stacks[stackId];
        var stackPath = material.name + "." + stack.name
        if (!mapsList.isChecked(stackPath)) continue
        stackProgress();

        var totalLayers = elementNbLayers(stack);
        var progressChannel = createProgressMethod("channel", stackNbChannel(this.materialName, stack));
        this.stackName = stack.name;

        for (var channelId in stack.channels) {
          this.channel = stack.channels[channelId];
          var channelPath = stackPath + "." + this.channel
          if (!mapsList.isChecked(channelPath)) continue
          progressChannel();

          var isColorChannel = (this.channel == "basecolor"
          || this.channel == "diffuse"
          || this.channel == "specular"
          || this.channel == "emissive"
          || this.channel == "transmissive"
          || this.channel == "absorptioncolor"
          || this.channel == "sheencolor"
          || this.channel == "coatcolor"
          || this.channel == "scatteringcolor"
          || this.channel == "specularedgecolor");

          var channelFormat = alg.mapexport.channelFormat([this.materialName, this.stackName],this.channel)
          var bitDepth = alg.settings.value("bitDepth", -1)

          if (isColorChannel && bitDepth === 16) {
              bitDepth = 8;
          }

          this.exportConfig.bitDepth = bitDepth == -1 ? channelFormat.bitDepth : bitDepth
          
          var filename = this.createFilename(".png");
          var exportConfig = this.exportConfig.clone()
          exportConfig.keepAlpha = false
          alg.mapexport.save([this.materialName, this.stackName, this.channel], filename, exportConfig);

          this.photoshopScript += this.newPSDDocumentStr(filename);
          
          var progressLayer = createProgressMethod("layer", totalLayers);
          for (var layerId = 0; layerId < stack.layers.length; ++layerId) {
            var layer = stack.layers[layerId];
            this.layersDFS(layer, progressLayer);
          }

          this.photoshopScript += "progressBar.layer.value = 0; \n";
          
          if(isColorChannel) {
            this.photoshopScript += "app.activeDocument.convertProfile( \"Working RGB\", Intent.PERCEPTUAL, false, false ); \n"
            this.photoshopScript += "try { app.activeDocument.colorProfileName = \"sRGB IEC61966-2.1\"; } catch(e) {}\n";
          }
          if(this.channel === "normal") {
            this.photoshopScript += this.newFillLayerStr("Background", {R:128, G:128, B:255});
            this.photoshopScript += "app.activeDocument.activeLayer.move(app.activeDocument, ElementPlacement.PLACEATEND); \n";
          }
          this.photoshopScript += "snapshot.move(app.activeDocument, ElementPlacement.PLACEATBEGINNING); \n";
          this.photoshopScript += "app.activeDocument.activeLayer = snapshot; \n";
          this.photoshopScript += "snapshot.visible = false; \n";
          this.photoshopScript += " app.activeDocument.saveAs(File(\"" + this.createFilename() + "\")); \n";
        }
        this.photoshopScript += "progressBar.channel.value = 0; \n";
      }
    }
  },

  layersDFS: function(layer, progressLayer) {
    if (layer.layers == undefined) {
      // 策略 1：导出专供分析的纯净文件 (屏蔽透明度干扰，强制无限扩散填满全屏)
      var filename_analysis = this.createFilename("_" + layer.uid + "_analysis.png");
      var config_analysis = this.exportConfig.clone();
      config_analysis.padding = "Infinite";
      config_analysis.keepAlpha = false; 
      alg.mapexport.save([layer.uid, this.channel], filename_analysis, config_analysis);

      // 策略 2：导出带有 SP 官方 Padding 和正确透明度的实际显示图片
      var filename_actual = this.createFilename("_" + layer.uid + ".png");
      alg.mapexport.save([layer.uid, this.channel], filename_actual, this.exportConfig);

      progressLayer();

      // 把这两张图交给 PS 后台，做智能裁决
      this.photoshopScript += this.newLayerStr(filename_actual, filename_analysis, layer, this.channel);

      if (layer.hasMask == true) {
        this.addMask(layer, progressLayer);
      }
    }
    else {
      this.photoshopScript += this.newFolderStr(layer, this.channel);
      if (layer.hasMask == true) {
        this.addMask(layer, progressLayer);
      }
      for (var layerId = 0; layerId < layer.layers.length; ++layerId) {
        this.layersDFS(layer.layers[layerId], progressLayer);
      }
      this.photoshopScript += " app.activeDocument.activeLayer = folders.pop();\n";
      this.photoshopScript += " app.activeDocument.activeLayer.visible = " + (layer.enabled? "true" : "false") + ";";
    }
  },

  addMask: function(layer, progressLayer) {
    var filename = this.createFilename("_" + layer.uid + "_mask.png");
    alg.mapexport.save([layer.uid, "mask"], filename, this.exportConfig);
    progressLayer();
    this.photoshopScript += this.newMaskStr(filename);
  },

  createFilename: function(concate) {
    concate = concate || ''
    return (this.exportPath + this.materialName + "_" +this.stackName + "_" + this.channel + concate).replace("__", "_");
  },

  newPSDDocumentStr: function(filename) {
    return "\n\n//New Document \n\
   var exportFile = File(\"" + filename + "\"); \n\
   open(exportFile); \n\
   exportFile.remove();\n\
   var folders = []; \n\
   folders.push(app.activeDocument); \n\
   var snapshot = app.activeDocument.activeLayer; \n\
   snapshot.name = \"snapshot\"; ";
  },

  newMaskStr: function(filename) {
    return " //Add mask \n\
   var maskFile = File(\"" + filename + "\"); \n\
   open_png(maskFile); \n\
   maskFile.remove(); \n\
   layerToMask();";
  },

  newFolderStr: function(folder, channel) {
    var blending = alg.mapexport.layerBlendingModes(folder.uid)[channel];
    return "\n\n //Add folder \n\
   folders.push(folders[folders.length - 1].layerSets.add()); \n\
   app.activeDocument.activeLayer.opacity = " + blending.opacity + ";\n\
   " + this.convertBlendingMode(blending.mode, 1) + "; \n\
   app.activeDocument.activeLayer.name = \"" + folder.name + "\"; ";
  },

  newLayerStr: function(filename_actual, filename_analysis, layer, channel) {
    var blending = alg.mapexport.layerBlendingModes(layer.uid)[channel];
    var str = "\n\n //Add layer \n";
    str += "var actualFile = File(\"" + filename_actual + "\"); \n";
    str += "var analysisFile = File(\"" + filename_analysis + "\"); \n";
    str += "var isSolid = false;\n";
    str += "var solidR = 0, solidG = 0, solidB = 0;\n";
    
    // 用分析图 (无死角纯色) 进行极简准确判定
    str += "try {\n";
    str += "  var tempDoc = app.open(analysisFile);\n";
    str += "  var rHist = tempDoc.channels[0].histogram;\n";
    str += "  var gHist = tempDoc.channels[1].histogram;\n";
    str += "  var bHist = tempDoc.channels[2].histogram;\n";
    str += "  var total = tempDoc.width.value * tempDoc.height.value;\n";
    str += "  var rMax = 0, gMax = 0, bMax = 0;\n";
    str += "  var rIdx = 0, gIdx = 0, bIdx = 0;\n";
    
    str += "  for (var i = 0; i < 256; i++) {\n";
    str += "    if (rHist[i] > rMax) { rMax = rHist[i]; rIdx = i; }\n";
    str += "    if (gHist[i] > gMax) { gMax = gHist[i]; gIdx = i; }\n";
    str += "    if (bHist[i] > bMax) { bMax = bHist[i]; bIdx = i; }\n";
    str += "  }\n";
    
    str += "  if (total > 0 && rMax >= total * 0.95 && gMax >= total * 0.95 && bMax >= total * 0.95) {\n";
    str += "    isSolid = true; solidR = rIdx; solidG = gIdx; solidB = bIdx;\n";
    str += "  }\n";
    str += "  tempDoc.close(SaveOptions.DONOTSAVECHANGES);\n";
    str += "} catch(e) {}\n";
    str += "try { analysisFile.remove(); } catch(e) {}\n"; 
    
    str += "folders[folders.length - 1].artLayers.add(); \n";
    str += "if (isSolid) {\n";
    str += "  var emptyLyr = app.activeDocument.activeLayer;\n";
    str += "  fillSolidColour(solidR, solidG, solidB);\n";
    str += "  try { var idDlt = charIDToTypeID('Dlt '); var descDlt = new ActionDescriptor(); var refDlt = new ActionReference(); refDlt.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('Msk ')); descDlt.putReference(charIDToTypeID('null'), refDlt); executeAction(idDlt, descDlt, DialogModes.NO); } catch(e) {}\n";
    
    if (layer.hasMask == false) {
      str += "  try {\n";
      str += "    open_png(actualFile);\n";
      str += "    layerToMask();\n";
      str += "  } catch(e) {}\n";
    }
    
    str += "  try { emptyLyr.remove(); } catch(e) {}\n";
    str += "  try { actualFile.remove(); } catch(e) {}\n";
    str += "} else {\n";
    // 判定为多色层，载入用户自己设定 Padding 的实际显示图层！
    str += "  open_png(actualFile);\n";
    // 只有用户没有勾选“保留智能对象”时，才将这个多色图层栅格化为普通图层
    var keepSmartObject = alg.settings.value("keepSmartObject", true);
    if (!keepSmartObject) {
      str += "  try { app.activeDocument.activeLayer.rasterize(RasterizeType.ENTIRELAYER); } catch(e) {}\n";
    }
    str += "  try { actualFile.remove(); } catch(e) {}\n";
    str += "}\n";
    
    str += "app.activeDocument.activeLayer.opacity = " + blending.opacity + ";\n";
    str += this.convertBlendingMode(blending.mode, 0) + ";\n";
    str += "app.activeDocument.activeLayer.name = \"" + layer.name + "\";\n";
    str += "app.activeDocument.activeLayer.visible = " + (layer.enabled ? "true" : "false") + ";\n";
    return str;
  },

  newFillLayerStr: function(name, color) {
    return "\n\n //Add fill layer \n\
   var layer = folders[folders.length - 1].artLayers.add(); \n\
   app.activeDocument.activeLayer.name = \"" + name + "\"; \n\
   fillSolidColour(" + color.R + "," + color.G + "," + color.B + ");\n\
   ";
  },

  convertBlendingMode: function(painterMode, isFolder) {
    var blendingMode = "app.activeDocument.activeLayer.blendMode = BlendMode.";
    if (painterMode == "Passthrough") {
      if (isFolder == 1) {
        blendingMode = blendingMode + "PASSTHROUGH";
      } else {
        blendingMode = blendingMode + "NORMAL";
      }
      return blendingMode;
    }
    switch(painterMode) {
    case "Normal":
    case "Replace":                      blendingMode = blendingMode + "NORMAL"; break;
    case "Multiply":                     blendingMode = blendingMode + "MULTIPLY"; break;
    case "Divide":                       blendingMode = blendingMode + "DIVIDE"; break;
    case "Linear dodge (Add)":           blendingMode = blendingMode + "LINEARDODGE"; break;
    case "Subtract":                     blendingMode = blendingMode + "SUBTRACT"; break;
    case "Difference":                   blendingMode = blendingMode + "DIFFERENCE"; break;
    case "Exclusion":                    blendingMode = blendingMode + "EXCLUSION"; break;
    case "Overlay":                      blendingMode = blendingMode + "OVERLAY"; break;
    case "Screen":                       blendingMode = blendingMode + "SCREEN"; break;
    case "Linear burn":                  blendingMode = blendingMode + "LINEARBURN"; break;
    case "Color burn":                   blendingMode = blendingMode + "COLORBURN"; break;
    case "Color dodge":                  blendingMode = blendingMode + "COLORDODGE"; break;
    case "Soft light":                   blendingMode = blendingMode + "SOFTLIGHT"; break;
    case "Hard light":                   blendingMode = blendingMode + "HARDLIGHT"; break;
    case "Vivid light":                  blendingMode = blendingMode + "VIVIDLIGHT"; break;
    case "Pin light":                    blendingMode = blendingMode + "PINLIGHT"; break;
    case "Saturation":                   blendingMode = blendingMode + "SATURATION"; break;
    case "Color":                        blendingMode = blendingMode + "COLORBLEND"; break;
    case "Normal map combine":           blendingMode = "Overlay_Normal()"; break;
    case "Normal map detail":            blendingMode = "Overlay_Normal()"; break;
    case "Normal map inverse detail":    blendingMode = "Overlay_Normal()"; break;
    default:
      blendingMode = ""
    }
    return blendingMode;
  }
}

function importPainterDocument(callback) {
  new PhotoshopExporter(callback);
}