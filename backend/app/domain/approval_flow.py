"""审批流程"""


def get_next_approver(flow_nodes: list, current_node: int) -> dict:
    """获取下一个审批人"""
    if current_node + 1 < len(flow_nodes):
        return flow_nodes[current_node + 1]
    return None


def is_final_node(flow_nodes: list, current_node: int) -> bool:
    """是否是最后一个节点"""
    return current_node + 1 >= len(flow_nodes)
