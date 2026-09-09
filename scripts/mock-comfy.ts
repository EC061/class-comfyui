import { mockComfy } from "../tests/mock-comfy";
void mockComfy(Number(process.env.PORT || 8188)).then((m) => console.log(`Mock worker ready at ${m.url}`));
