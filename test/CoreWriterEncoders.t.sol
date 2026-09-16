// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoreConstants} from "../src/CoreConstants.sol";

/// Byte-layout check for the Stage 0 hedge-spike encoders (UNVERIFIED live):
/// version byte, 3-byte BE action id, then plain abi.encode of the documented
/// field tuple. Guards the ids and field order against typos before the spike.
contract CoreWriterEncodersTest is Test {
    function _split(bytes memory p) internal pure returns (uint8 v, uint24 id, bytes memory params) {
        v = uint8(p[0]);
        id = (uint24(uint8(p[1])) << 16) | (uint24(uint8(p[2])) << 8) | uint24(uint8(p[3]));
        params = new bytes(p.length - 4);
        for (uint256 i = 4; i < p.length; i++) {
            params[i - 4] = p[i];
        }
    }

    function test_limitOrder() public pure {
        uint32 asset = CoreConstants.outcomeAssetId(12385, false);
        assertEq(asset, 100_123_851);
        (uint8 v, uint24 id, bytes memory params) =
            _split(CoreConstants.encodeLimitOrder(asset, true, 55_000_000, 1e9, false, CoreConstants.TIF_GTC, 7));
        assertEq(v, 1);
        assertEq(id, 1);
        assertEq(params, abi.encode(asset, true, uint64(55_000_000), uint64(1e9), false, uint8(2), uint128(7)));
    }

    function test_cancelsAgentBuilder() public pure {
        (, uint24 id, bytes memory params) = _split(CoreConstants.encodeCancelByOid(5, 9));
        assertEq(id, 10);
        assertEq(params, abi.encode(uint32(5), uint64(9)));
        (, id, params) = _split(CoreConstants.encodeCancelByCloid(5, 9));
        assertEq(id, 11);
        assertEq(params, abi.encode(uint32(5), uint128(9)));
        (, id, params) = _split(CoreConstants.encodeAddApiWallet(address(0xA), ""));
        assertEq(id, 9);
        assertEq(params, abi.encode(address(0xA), ""));
        (, id, params) = _split(CoreConstants.encodeApproveBuilderFee(10, address(0xB)));
        assertEq(id, 12);
        assertEq(params, abi.encode(uint64(10), address(0xB)));
    }
}
