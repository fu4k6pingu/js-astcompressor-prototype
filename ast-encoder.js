'use strict';

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports'], factory);
  } else if (typeof exports !== 'undefined') {
    factory(exports);
  } else {
    factory((root.astEncoder = {}));
  }
}(this, function (exports) {
  var common = require("./ast-common.js");

  var NamedTable  = common.NamedTable,
      UniqueTable = common.UniqueTable,
      StringTable = common.StringTable,
      ObjectTable = common.ObjectTable,
      GetObjectId = common.GetObjectId;

  var IoTrace = false;

  function ValueWriter () {
    // HACK: Max size 32mb because growable buffers are effort
    var maxSize = (1024 * 1024) * 32;

    this.bytes    = new Uint8Array(maxSize);
    this.position = 0;
    this.view     = new DataView(this.bytes.buffer);

    this.varintSizes = [0, 0, 0, 0, 0, 0];
  };

  ValueWriter.prototype.getPosition = function () {
    return this.position;
  };

  ValueWriter.prototype.skip = function (distance) {
    this.position += distance;
  };

  ValueWriter.prototype.write = 
  ValueWriter.prototype.writeByte = function (b) {
    if (this.position >= this.bytes.length)
      throw new Error("buffer full");

    this.bytes[this.position++] = b;
  };

  ValueWriter.prototype.writeBytes = function (bytes, offset, count) {
    if (this.position >= this.bytes.length)
      throw new Error("buffer full");

    if (arguments.length === 1) {
      this.bytes.set(bytes, this.position);
      this.position += bytes.length;
      return;
    } else if (arguments.length === 3) {
      offset |= 0;
      count |= 0;
    } else {
      throw new Error("Expected (bytes) or (bytes, offset, count)");
    }

    this.bytes.set(bytes.subarray(offset, offset + count), this.position);
    this.position += count;
  };

  ValueWriter.prototype.writeScratchBytes = function (count) {
    this.writeBytes(this.scratchBytes, 0, count);
  };

  ValueWriter.prototype.writeUint32 = function (value) {
    if (IoTrace)
      console.log("write uint", value.toString(16));

    this.view.setUint32(this.position, value, true);
    this.position += 4;
  };

  ValueWriter.prototype.writeInt32 = function (value) {
    if (IoTrace)
      console.log("write int", value.toString(16));

    this.view.setInt32(this.position, value, true);
    this.position += 4;
  };

  ValueWriter.prototype.writeVarUint32 = function (value) {
    if (common.EnableVarints) {
      if (IoTrace)
        console.log("write varuint", value.toString(16));

      var before = this.position;
      common.writeLEBUint32(this, value);
      var after = this.position;
      var lengthBytes = after - before;
      this.varintSizes[lengthBytes - 1] += 1;
    } else {
      this.writeUint32(value);
    }
  };

  ValueWriter.prototype.writeIndex = function (value) {
    if (value === 0xFFFFFFFF)
      this.writeVarUint32(0);
    else
      this.writeVarUint32(value + 1);
  };

  ValueWriter.prototype.writeFloat64 = function (value) {
    if (IoTrace)
      console.log("write float64", value.toFixed(4));

    this.view.setFloat64(this.position, value, true);
    this.position += 8;
  };

  ValueWriter.prototype.writeUtf8String = function (text) {
    var lengthBytes = 0;
    var counter = {
      write: function (byte) {
        lengthBytes += 1;
      },
      getResult: function () {
      }
    };

    // Encode but discard bytes to compute length
    encoding.UTF8.encode(text, counter);

    this.writeVarUint32(lengthBytes);
    encoding.UTF8.encode(text, this);
  };

  ValueWriter.prototype.getResult = 
  ValueWriter.prototype.toArray = function () {
    return this.bytes.subarray(0, this.position);
  };


  function JsAstModule (shapes) {
    this.shapes  = shapes;

    // Used to store the inferred type tags for arrays during
    //  the initial tree-walk
    this.arrayTypeTags = new Map();

    this.tags    = new StringTable("tag");
    this.strings = new StringTable("string");
    this.arrays  = new ObjectTable("array");

    this.tags.add("any");
    this.tags.add("object");

    this.objects = new ObjectTable("object");
    this.objectTableCount = 1;

    this.anyTypeValuesWritten = 0;

    this._getTableForTypeTag = this.getTableForTypeTag.bind(this);
  };


  JsAstModule.prototype.getObjectTable = function (nodeOrShape) {
    if (nodeOrShape === null)
      return null;

    return this.objects;
  };


  JsAstModule.prototype.forEachObjectTable = function (callback) {
    callback(this.objects, "object");
  };


  JsAstModule.prototype.deduplicateObjectTable = function (state, table) {
    var count = 0, originalCount = table.count;

    // Assign temporary unique indices to all observed values
    var temporaryIndices = Object.create(null);
    var nextTemporaryIndex = 0;

    var contentStrings = state.contentStrings;
    var cycleSentinel = state.cycleSentinel;
    var objectsByContentString = state.objectsByContentString;

    function getTemporaryIndex (value) {
      var existing = temporaryIndices[value];
      if (typeof (existing) !== "number") {
        temporaryIndices[value] = existing = nextTemporaryIndex++;
      }

      return existing;
    };

    function generateContentString (obj) {
      var result = "";

      for (var k in obj) {
        if (!obj.hasOwnProperty(k))
          continue;

        var v = obj[k];

        if (typeof (v) === "object") {
          if (v === null) {
            result += "n";
          } else {
            var cs = getContentString(v);
            result += "[" + cs + "]";
          }
        } else {
          var id = getTemporaryIndex(v);
          var hexId = id.toString(16);

          if (result !== "")
            result += " ";

          result += hexId;
        }
      }

      return result;
    };

    function getContentString (obj) {
      var id = GetObjectId(obj);
      var existing = contentStrings[id];

      if (existing === cycleSentinel) {
        return id;
      } else if (typeof (existing) !== "string") {
        contentStrings[id] = cycleSentinel;

        existing = generateContentString(obj);

        contentStrings[id] = existing;
      }

      return existing;
    };

    table.forEach(function deduplicateObjects_callback (id) {
      // FIXME: This is a gross hack where we do deduplication
      //  based on shallowly serializing the object and using that to
      //  find duplicates.
      // A tree-walking comparison or something would probably be better.
      // An approach where we walk up from the leaves to the root deduplicating
      //  might be faster.

      var obj = id.get_value();
      var objCS = getContentString(obj);

      var existing = objectsByContentString[objCS];

      if (existing && existing.equals(id)) {
        // Do nothing
      } else if (existing) {
        count += 1;
        table.dedupe(id, existing);
      } else {
        objectsByContentString[objCS] = id;
      }
    });

    // We shouldn't need more than one pass since we were doing structural 
    //  deduplication - all possibly deduplicated objects should get caught
    //  in the first pass by looking at structure instead of for matching IDs

    state.originalCount += originalCount;
    state.count += count;
  };


  JsAstModule.prototype.deduplicateObjects = function () {
    var state = {
      contentStrings:         Object.create(null),
      cycleSentinel:          Object.create(null),
      objectsByContentString: Object.create(null),
      originalCount:          0,
      count:                  0
    };

    this.forEachObjectTable(this.deduplicateObjectTable.bind(this, state));

    if (state.count > 0) {
      console.log(
        "Deduped " + state.count + 
        " object(s) (" + 
        (state.count / state.originalCount * 100.0).toFixed(1) + 
        "%)"
      );
    }    
  };


  JsAstModule.prototype.getShapeForObject = function (obj) {
    var shapeName = obj[this.shapes.shapeKey];

    if (typeof (shapeName) !== "string") {
      // HACK so js RegExp instances can fit into this shape model
      if (
        (typeof (obj) === "object") &&
        (Object.getPrototypeOf(obj) === RegExp.prototype)
      )
        shapeName = "RegExp";
      else
        throw new Error("Unsupported object " + obj + " with shape name " + JSON.stringify(shapeName))
    }

    var shape = this.shapes.get(shapeName);
    if (!shape) {
      console.log(shapeName, obj, Object.getPrototypeOf(obj), obj.toString());
      throw new Error("Unknown shape " + shapeName);
    }

    var shapeTagIndex = null;
    if (this.tags.isFinalized) {
      shapeTagIndex = this.tags.get_index(shapeName);
    } else {
      this.tags.add(shapeName);
    }

    return {
      name: shapeName,
      shape: shape,
      tagIndex: shapeTagIndex
    };
  };


  JsAstModule.prototype.serializeFieldValue = function (writer, shape, field, value) {
    // FIXME: Hack together field definition type -> tag conversion
    var tag = common.pickTagForField(field, this._getTableForTypeTag);

    try {
      this.serializeValueWithKnownTag(writer, value, tag);
    } catch (exc) {
      console.log("Failed while writing field " + field.name + " of type " + shape.name);
      throw exc;
    }
  };


  JsAstModule.prototype.serializeObject = function (writer, node) {
    if (Array.isArray(node))
      throw new Error("Should have used serializeArray");

    var shape = this.getShapeForObject(node);
    if (shape.tagIndex === null)
      throw new Error("Tag table not finalized");

    if (IoTrace)
      console.log("// object body");

    writer.writeVarUint32(shape.tagIndex);

    var self = this, fields = shape.shape.fields;
    for (var i = 0, l = fields.length; i < l; i++) {
      var fd = fields[i];
      var value = node[fd.name];

      if (typeof (value) === "undefined")
        value = null;

      this.serializeFieldValue(writer, shape, fd, value);

      if (IoTrace)
        console.log("// " + fd.name + " =", value);      
    }
  };


  JsAstModule.prototype.getTypeTagForValue = function (value) {
    var jsType = typeof (value);

    if (value === null)
      return "null";

    switch (jsType) {
      case "string":
        return "string";

      case "boolean":
        return value ? "true" : "false";

      case "number":
        var i = value | 0;
        if (i === value)
          return "integer";
        else
          return "double";

      case "object":
        if (Array.isArray(value)) {
          return "array";
        } else {
          var shape = this.getShapeForObject(value);
          return shape.name;
        }

      default: {
        throw new Error("Unhandled value type " + jsType);
      }
    }       
  };


  JsAstModule.prototype.getIndexForTypeTag = function (tag) {
    return this.tags.get_index(tag);
  };


  JsAstModule.prototype.getTableForTypeTag = function (tag, actualValueTag) {
    if (actualValueTag === "null")
      return null;

    if (tag === "string")
      return this.strings;
    else if (tag === "array")
      return this.arrays;
    else {
      var shape = this.shapes.get(tag);
      if (shape) {
        return this.getObjectTable(shape);
      } else if (tag === "object") {
        return this.getObjectTable("object");
      } else {
        return null;
      }
    }
  };


  // Or unknown tag, if you pass 'any', because why not.
  JsAstModule.prototype.serializeValueWithKnownTag = function (writer, value, tag) {
    switch (tag) {
      case "true":
      case "false":
      case "null":
        // no-op. value is encoded by the type tag.
        return;

      case "boolean":
        writer.writeByte(value ? 1 : 0);
        return;

      case "integer":
        // TODO: varint?
        writer.writeInt32(value);
        return;

      case "double":
        writer.writeFloat64(value);
        return;

      case "any": {
        if (IoTrace)
          console.log("write any ->");

        // FIXME: gross.
        tag = this.getTypeTagForValue(value);
        if (tag === "any")
          throw new Error("Couldn't identify a tag for 'any' value");

        this.anyTypeValuesWritten += 1;
        var tagIndex = this.getIndexForTypeTag(tag);
        writer.writeVarUint32(tagIndex);

        return this.serializeValueWithKnownTag(writer, value, tag);
      }

      case "object":
      default:
        break;
    }

    if (value === null) {
      writer.writeIndex(0xFFFFFFFF);
      return;
    }

    var actualValueTag = this.getTypeTagForValue(value);
    var table = this.getTableForTypeTag(tag, actualValueTag);
    if (!table)
      throw new Error("No table for value with tag '" + tag + "'");

    var isUntypedObject = (tag === "object");

    if ((actualValueTag !== tag) && !isUntypedObject)
      throw new Error("Shape information specified type '" + tag + "' but actual type is '" + actualValueTag + "'");

    if (IoTrace) {
      if (tag !== actualValueTag)
        console.log("write " + tag + " -> " + actualValueTag);
      else
        console.log("write " + tag);
    }

    try {
      var index = table.get_index(value);

      // There's only one global object table, so we can encode everything
      //  as a single index.
      writer.writeIndex(index);
    } catch (err) {
      console.log("Failed while writing '" + tag + "'", value);
      throw err;
    }
  }


  JsAstModule.prototype.serializeArray = function (writer, node) {
    if (!Array.isArray(node))
      throw new Error("Should have used serializeObject");

    writer.writeVarUint32(node.length);

    var tag = this.arrayTypeTags.get(node);
    if (!tag)
      throw new Error("No precomputed type tag for array");

    var tagIndex = this.getIndexForTypeTag(tag);
    writer.writeVarUint32(tagIndex);

    for (var i = 0, l = node.length; i < l; i++) {
      this.serializeValueWithKnownTag(writer, node[i], tag);
    }
  };


  JsAstModule.prototype.serializeTable = function (writer, table, ordered, serializeEntry) {
    var finalized = table.finalize(0);

    writer.writeUint32(finalized.length);

    for (var i = 0, l = finalized.length; i < l; i++) {
      var id = finalized[i];
      var value = id.get_value();

      // gross
      serializeEntry.call(this, writer, value);
    }
  };


  JsAstModule.prototype.finalize = function () {
    this.tags   .finalize(0);
    this.strings.finalize(0);
    this.arrays .finalize(0);

    var globalBaseIndex = 0;
    this.forEachObjectTable(function (table) {
      table.globalBaseIndex = globalBaseIndex;
      table.finalize(0);
      globalBaseIndex += table.get_count();
    });
  };


  function astToModule (root, shapes) {
    var result = new JsAstModule(shapes);

    var walkedCount = 0;
    var progressInterval = 500000;

    var walkCallback = function astToModule_walkCallback (node, key, value) {
      var tag = result.getTypeTagForValue(value);
      var table = result.getTableForTypeTag(tag);

      result.tags.add(tag);

      if (table)
        table.add(value);

      walkedCount++;
      if ((walkedCount % progressInterval) === 0) {
        console.log("Scanned " + walkedCount + " nodes");
        // console.log(key, value);
      }
    };

    var walkArray = function astToModule_walkArray (array) {
      // HACK: Identify arrays where all elements live in the same table.
      // This is to compensate for this prototype not using static type information
      //  from the shapes table when compressing arrays.
      // (A real implementation would not have this problem.)
      var commonTypeTag = null;
      for (var i = 0, l = array.length; i < l; i++) {
        var item = array[i];
        var tag = result.getTypeTagForValue(item);
      
        if (commonTypeTag === null) {
          commonTypeTag = tag;
        } else if (commonTypeTag !== tag) {
          commonTypeTag = null;
          break;
        }
      }
      
      if (commonTypeTag === null)
        commonTypeTag = "any";

      result.arrayTypeTags.set(array, commonTypeTag);

      for (var i = 0, l = array.length; i < l; i++)
        walkCallback(array, i, array[i]);
    };

    var rootTag = result.getTypeTagForValue(root);
    var rootTable = result.getTableForTypeTag(rootTag);
    rootTable.add(root);

    astutil.mutate(root, function visit (context, node) {
      if (!node)
        return;

      var nodeTable;

      if (Array.isArray(node)) {
        walkArray(node);
      } else {
        // FIXME: Use shape information to walk instead of 'for in'
        for (var k in node) {
          if (!node.hasOwnProperty(k))
            continue;

          walkCallback(node, k, node[k]);
        }
      }
    });

    result.root = root;

    return result;
  };


  // Converts a JsAstModule into bytes and writes them into byteWriter.
  function serializeModule (module, byteWriter, stats) {
    var writer = new ValueWriter();

    writer.writeBytes(common.Magic);
    writer.writeUtf8String(common.FormatName);

    /*
    module.serializeTable(writer, module.identifiers, serializeUtf8String);
    */

    module.finalize();

    // We write out the lengths in advance of the (length-prefixed) tables.
    // This allows a decoder to preallocate space for all the tables and
    //  use that to reconstruct relationships in a single pass.

    var tagCount    = module.tags.get_count();
    var stringCount = module.strings.get_count();
    var arrayCount  = module.arrays.get_count();

    writer.writeUint32(tagCount);
    writer.writeUint32(stringCount);
    writer.writeUint32(arrayCount);

    module.serializeTable(writer, module.tags, true, function (writer, value) {
      writer.writeUtf8String(value);
    });

    writer.writeUint32(module.objectTableCount);

    module.forEachObjectTable(function (table, key) {
      // FIXME: Tag index instead? Implied tag index by order?
      writer.writeUint32(module.tags.get_index(key));
      writer.writeUint32(table.get_count());

      // If global index spaces are in use, we write the base
      //  index here so that the decoder knows it early.
      if (common.GlobalIndexSpace)
        writer.writeUint32(table.globalBaseIndex);
    });

    module.serializeTable(writer, module.strings, true, function (writer, value) {
      writer.writeUtf8String(value);
    });

    module.forEachObjectTable(function (table) {
      // IoTrace = (table.semantic === "IfStatement");
      if (IoTrace)
        console.log("// table " + table.semantic);

      module.serializeTable(writer, table, true,  module.serializeObject);
    });
    
    module.serializeTable(writer, module.arrays,  true,  module.serializeArray);

    module.serializeValueWithKnownTag(writer, module.root, "any");

    console.log("any-typed values written:", module.anyTypeValuesWritten);
    console.log("varint sizes:", writer.varintSizes);

    return writer.toArray();
  };


  exports.PrettyJson      = common.PrettyJson;

  exports.ShapeTable      = common.ShapeTable;

  exports.astToModule     = astToModule;
  exports.serializeModule = serializeModule;
}));