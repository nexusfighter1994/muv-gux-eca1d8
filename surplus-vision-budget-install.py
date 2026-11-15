"""Apply a model/effort/role-scoped output budget after native Surplus defaults."""
ANCHOR = 'f.model=e.modelOverridden?a:kp,Number(f.max_tokens)>0||(f.max_tokens=Lvn(o)),$te('
PATCHED = ANCHOR.replace(',$te(', ',/* vf-custom:surplus-vision-budget-v1 */f.max_tokens=__vfCustom.surplusOutputBudget(e,o,r.pipelineId,f.max_tokens),$te(')


def patch_node(source):
    old, new = source.count(ANCHOR), source.count(PATCHED)
    if (old, new) == (0, 1):
        return source
    if (old, new) != (1, 0):
        raise RuntimeError('Native Surplus output budget fingerprint missing, changed or ambiguous')
    return source.replace(ANCHOR, PATCHED, 1)
