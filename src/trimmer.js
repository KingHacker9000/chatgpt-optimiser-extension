(() => {
  "use strict";

  const HIDDEN_ROLES = new Set(["system", "tool", "thinking"]);

  function roleOf(node) {
    return node?.message?.author?.role || null;
  }

  function isVisibleNode(node) {
    const role = roleOf(node);
    return Boolean(role && !HIDDEN_ROLES.has(role));
  }

  function activePath(data) {
    const mapping = data?.mapping;
    const currentNode = data?.current_node;
    if (!mapping || !currentNode || !mapping[currentNode]) return null;

    const reversed = [];
    const visited = new Set();
    let cursor = currentNode;
    while (cursor && mapping[cursor] && !visited.has(cursor)) {
      visited.add(cursor);
      reversed.push(cursor);
      cursor = mapping[cursor].parent || null;
    }
    reversed.reverse();
    return reversed.length ? reversed : null;
  }

  function extractPart(part, depth = 0) {
    if (depth > 5 || part == null) return "";
    if (typeof part === "string") return part;
    if (typeof part === "number" || typeof part === "boolean") return String(part);
    if (Array.isArray(part)) return part.map((item) => extractPart(item, depth + 1)).filter(Boolean).join("\n");
    if (typeof part !== "object") return "";

    const contentType = String(part.content_type || part.type || "").toLowerCase();
    if (contentType.includes("image")) return "[Image]";
    if (contentType.includes("audio")) return "[Audio]";
    if (contentType.includes("video")) return "[Video]";
    if (contentType.includes("file")) return part.name ? `[File: ${part.name}]` : "[File]";

    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    if (part.parts) return extractPart(part.parts, depth + 1);
    if (part.content && typeof part.content === "object") return extractPart(part.content, depth + 1);
    return "";
  }

  function messageText(node) {
    const message = node?.message;
    if (!message) return "";
    const text = extractPart(message.content);
    return text.replace(/\u0000/g, "").trim();
  }

  function flattenVisibleTurns(path, mapping) {
    const turns = [];
    let current = null;

    for (const id of path) {
      const node = mapping[id];
      if (!isVisibleNode(node)) continue;
      const role = roleOf(node) || "unknown";
      const text = messageText(node);
      const createTime = node?.message?.create_time ?? null;

      if (!current || current.role !== role) {
        current = {
          id,
          role,
          text: text || "",
          createTime
        };
        turns.push(current);
      } else if (text) {
        current.text = current.text ? `${current.text}\n\n${text}` : text;
      }
    }

    return turns;
  }

  function trimConversation(data, limit) {
    const mapping = data?.mapping;
    const path = activePath(data);
    if (!mapping || !path) return null;

    const visibleTurns = flattenVisibleTurns(path, mapping);
    const visibleTotal = visibleTurns.length;
    const effectiveLimit = Math.max(1, Number(limit) || 1);

    if (visibleTotal <= effectiveLimit) {
      return {
        changed: false,
        mapping,
        currentNode: data.current_node,
        root: data.root || path[0],
        visibleTotal,
        visibleKept: visibleTotal,
        archive: []
      };
    }

    let visibleCount = 0;
    let lastVisibleRole = null;
    let cutIndex = 0;

    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = mapping[path[index]];
      if (!isVisibleNode(node)) continue;
      const role = roleOf(node);
      if (role !== lastVisibleRole) {
        visibleCount += 1;
        lastVisibleRole = role;
      }
      if (visibleCount > effectiveLimit) {
        cutIndex = index + 1;
        break;
      }
    }

    if (cutIndex <= 0) return null;

    const keptSuffix = path.slice(cutIndex);
    const firstPathId = path[0];
    const firstPathNode = mapping[firstPathId];
    const preserveRoot = Boolean(firstPathId && firstPathNode && !isVisibleNode(firstPathNode));
    const newMapping = {};

    if (preserveRoot) {
      newMapping[firstPathId] = {
        ...firstPathNode,
        parent: null,
        children: keptSuffix[0] ? [keptSuffix[0]] : []
      };
    }

    for (let index = 0; index < keptSuffix.length; index += 1) {
      const id = keptSuffix[index];
      const node = mapping[id];
      if (!node) continue;
      const previous = index === 0 ? (preserveRoot ? firstPathId : null) : keptSuffix[index - 1];
      const next = keptSuffix[index + 1] || null;
      newMapping[id] = {
        ...node,
        parent: previous,
        children: next ? [next] : []
      };
    }

    const newCurrent = keptSuffix[keptSuffix.length - 1];
    const newRoot = preserveRoot ? firstPathId : keptSuffix[0];
    if (!newCurrent || !newRoot) return null;

    return {
      changed: true,
      mapping: newMapping,
      currentNode: newCurrent,
      root: newRoot,
      visibleTotal,
      visibleKept: Math.min(effectiveLimit, visibleTotal),
      archive: visibleTurns.slice(0, Math.max(0, visibleTotal - effectiveLimit))
    };
  }

  Object.defineProperty(window, "__CGO_TRIMMER__", {
    value: Object.freeze({ trimConversation }),
    configurable: true
  });
})();
