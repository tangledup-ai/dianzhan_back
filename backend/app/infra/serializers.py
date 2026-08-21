"""响应序列化工具：snake_case → camelCase 统一转换

策略：
- to_camel(data, skip)：递归转换 dict/list 的 key 为 camelCase（用于最终单 key 模式）
- add_camel_aliases(data, skip)：过渡模式，每个 key 同时保留 snake 和新增 camel 别名，
  让旧前端继续读 snake、新前端逐步读 camel。全部迁移完成后切到 to_camel。
- skip 参数：跳过不转换的 key（如第三方原始数据 raw_data 里的 JSONB 内容）
"""
import re


def snake_to_camel(name: str) -> str:
    """station_name → stationName；meter_no → meterNo。已是 camel 则原样返回。"""
    if not isinstance(name, str) or "_" not in name:
        return name
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _should_skip(key: str, skip: frozenset) -> bool:
    if key in skip:
        return True
    # raw_data / rawData 这类第三方原始数据整体跳过（内部是外部系统字段，不该转换）
    if key == "raw_data" or key == "rawData":
        return True
    return False


def to_camel(data, skip: frozenset = frozenset()):
    """递归转换所有 key 为 camelCase。跳过 skip 集合中的 key。"""
    if isinstance(data, dict):
        return {
            snake_to_camel(k): to_camel(v, skip) if not _should_skip(k, skip) else v
            for k, v in data.items()
        }
    if isinstance(data, list):
        return [to_camel(item, skip) for item in data]
    return data


def add_camel_aliases(data, skip: frozenset = frozenset()):
    """过渡模式：每个 snake key 额外追加一个 camel 别名 key（值相同）。

    原 key 保留，前端读 snake 或 camel 都行。值如果是 dict/list 也递归加别名。
    raw_data 等 skip 的 key 不转换。
    """
    if isinstance(data, dict):
        result = {}
        for k, v in data.items():
            if _should_skip(k, skip):
                result[k] = v
                continue
            result[k] = add_camel_aliases(v, skip)
            camel = snake_to_camel(k)
            if camel != k and camel not in result:
                result[camel] = result[k]
        return result
    if isinstance(data, list):
        return [add_camel_aliases(item, skip) for item in data]
    return data
