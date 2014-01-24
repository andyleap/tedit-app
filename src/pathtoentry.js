/*global define*/
define("pathtoentry", function () {
  "use strict";

  var modes = require('modes');

  // Cache the tree entries by hash for faster path lookup.
  var cache = {};

  // Cached compiled directories that contain wildcards.
  var dirs = {};

  return function (repo) {
    if (!repo.submodules) repo.submodules = {};
    repo.pathToEntry = pathToEntry;
    repo.getCached = getCached;
    repo.loadAsCached = loadAsCached;
  };

  function getCached(hash) {
    return cache[hash];
  }

  function loadAsCached(type, hash, callback) {
    var repo = this;
    if (!callback) return loadAsCached.bind(repo, type, hash);
    if (hash in cache) return callback();
    repo.loadAs(type, hash, function (err, body) {
      if (err) return callback(err);
      if (!body) return callback(new Error("No such hash: " + hash));
      cache[hash] = body;
      callback();
    });
  }

  function pathToEntry(root, path, callback) {
    var repo = this;
    if (!callback) return pathToEntry.bind(repo, root, path);

    // Split path ignoring leading and trailing slashes.
    var parts = path.split("/").filter(String);
    var length = parts.length;
    var index = 0;

    // These contain the hash and mode of the path as we walk the segments.
    var mode = modes.tree;
    var hash = root;
    return walk();

    function patternCompile(source, target) {
      // Escape characters that are dangerous in regular expressions first.
      source = source.replace(/[\-\[\]\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
      // Extract all the variables in the source and target and replace them.
      source.match(/\{[a-z]+\}/g).forEach(function (match, i) {
        source = source.replace(match, "(.*)");
        target = target.replace(match, '$' + (i + 1));
      });
      var match = new RegExp("^" + source + "$");
      match.target = target;
      return match;
    }

    function compileDir(hash, tree, callback) {
      var left = 1;
      var done = false;
      var wilds = Object.keys(tree).filter(function (key) {
        return modes.isSymLink(tree[key].mode) && /\{[a-z]+\}/.test(key);
      });
      dirs[hash] = wilds;
      wilds.forEach(function (key, i) {
        if (done) return;
        var hash = tree[key].hash;
        var link = cache[hash];
        if (link) {
          wilds[i] = patternCompile(key, link);
          return;
        }
        left++;
        repo.loadAs("text", hash, function (err, link) {
          if (done) return;
          if (err) {
            done = true;
            return callback(err);
          }
          cache[hash] = link;
          wilds[i] = patternCompile(key, link);
          if (!--left) {
            done = true;
            callback();
          }
        });
      });
      if (!done && !--left) {
        done = true;
        callback();
      }
    }

    function walk(err) {
      if (err) return callback(err);
      var cached;
      outer:
      while (index < length) {
        // If the parent is a tree, look for our path segment
        if (modes.isTree(mode)) {
          cached = cache[hash];
          // If it's not cached yet, abort and resume later.
          if (!cached) return repo.loadAs("tree", hash, onValue);
          var name = parts[index];
          var entry = cached[name];
          if (!entry) {
            var dir = dirs[hash];
            if (!dir) return compileDir(hash, cached, walk);
            for (var i = 0, l = dir.length; i < l; i++) {
              var wild = dir[i];
              if (!wild.test(name)) continue;
              mode = modes.sym;
              hash = hash + "-" + name;
              cache[hash] = name.replace(wild, wild.target);
              break outer;
            }
            return callback();
          }
          index++;
          hash = entry.hash;
          mode = entry.mode;
          continue;
        }
        // If the parent is a symlink, adjust the path in-place and start over.
        if (modes.isSymLink(mode)) {
          cached = cache[hash];
          if (!cached) return repo.loadAs("text", hash, onValue);
          // Remove the tail and remove the symlink segment from the head.
          var tail = parts.slice(index);
          parts.length = index - 1;
          // Join the target resolving special "." and ".." segments.
          cached.split("/").forEach(onPart);
          // Add the tail back in.
          parts.push.apply(parts, tail);
          // Start over.  The already passed path will be cached and quite fast.
          hash = root;
          mode = modes.tree;
          index = 0;
          continue;
        }
        // If it's a submodule, jump over to that repo.
        if (modes.isCommit(mode)) {
          var parentPath = parts.slice(0, index).join("/");
          var submodule = repo.submodules[parentPath];
          if (!submodule) {
            return callback(new Error("Missing submodule for path: " + parentPath));
          }
          cached = cache[hash];
          if (!cached) return submodule.loadAs("commit", hash, onValue);
          var childPath = parts.slice(index).join("/");
          return submodule.pathToEntry(cached.tree, childPath, callback);
        }
        return callback(new Error("Invalid path segment"));
      }

      // We've reached the final segment, let's preload symlinks and trees since
      // we don't mind caching those.

      var result;
      if (modes.isTree(mode)) {
        cached = cache[hash];
        if (!cached) return repo.loadAs("tree", hash, onValue);
        result = { tree: cached };
      }
      else if (modes.isSymLink(mode)) {
        cached = cache[hash];
        if (!cached) return repo.loadAs("text", hash, onValue);
        result = { link: cached };
      }
      else if (modes.isCommit(mode)) {
        cached = cache[hash];
        if (!cached) return repo.loadAs("commit", hash, onValue);
        result = { commit: cached };
      }
      else {
        result = {};
      }
      result.mode = mode;
      result.hash = hash;
      // In the case of submodule traversal, the caller's repo is different
      result.repo = repo;

      return callback(null, result);

      // Used by the symlink code to resolve the target against the path.
      function onPart(part) {
        // Ignore leading and trailing slashes as well as "." segments.
        if (!part || part === ".") return;
        // ".." pops a path segment from the stack
        if (part === "..") parts.pop();
        // New paths segments get pushed on top.
        else parts.push(part);
      }

    }

    function onValue(err, value) {
      if (value === undefined) return callback(err);
      cache[hash] = value;
      return walk();
    }

  }

});